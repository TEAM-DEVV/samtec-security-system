import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { UserAccount, UserAccountList, UserAccountWithPasswordSetup } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { normalizeEmail } from '../../common/emails.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, User } from '../../generated/prisma/client.js';
import { EmployeesService } from '../workforce/employees.service.js';
import {
  accountStatus,
  awaitsAdminConfirmation,
  employeeLinkProblem,
  mayUseAccount,
} from './account-rules.js';
import { AccountsService } from './accounts.service.js';
import { AuditService } from './audit.service.js';
import { SignInThrottleService } from './sign-in-throttle.service.js';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './users.schemas.js';

/**
 * User management: administrators create, change, switch off and reset
 * sign-in accounts. Contract: the `Users` operations. Every route is ADMIN
 * only (`users.controller.ts`), and three rules keep the company safe:
 *
 * 1. **Nobody sees anyone's password.** New and reset accounts get a
 *    one-time link; the person chooses their own password with it.
 * 2. **Never on your own account** (except your name), so an administrator
 *    can never lock themselves out.
 * 3. **Changes that matter end every session at once** — switching off,
 *    changing the role or link, resetting — so the person's next request is
 *    refused and a newly promoted ADMIN or HR_PAYROLL must sign in again with
 *    two-factor authentication.
 * 4. **An ADMIN account takes two administrators** (Phase 7, docs/plan/06
 *    "Two administrators"). Creating one, promoting to one, resetting one or
 *    switching one back on leaves it waiting, unusable, until a different
 *    administrator confirms it — so one person cannot quietly give
 *    themselves a second administrator account to be "the other person" in
 *    every two-person rule. Taking power away needs nobody else.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly throttle: SignInThrottleService,
    private readonly employees: EmployeesService,
  ) {}

  async list(viewer: SignedInUser, query: ListUsersQuery): Promise<UserAccountList> {
    const afterId = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && afterId === undefined) {
      throw fieldProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    }
    // IDs are UUIDv7, which sort by creation time: oldest accounts first, and
    // the cursor carries no personal data.
    const rows = await this.prisma.user.findMany({
      where: { companyId: viewer.companyId, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.id);
    return { items: pageRows.map(toUserAccount), nextCursor };
  }

  async get(viewer: SignedInUser, userId: string): Promise<UserAccount> {
    return toUserAccount(await this.findInCompany(viewer, userId));
  }

  async create(viewer: SignedInUser, body: CreateUserBody): Promise<UserAccountWithPasswordSetup> {
    const employeeId = body.employeeId ?? null;
    assertLinkFits(body.role, employeeId);
    if (employeeId) {
      await this.assertEmployeeCanBeLinked(viewer, employeeId);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        let hold: Awaited<ReturnType<UsersService['adminHold']>> | undefined;
        if (body.role === 'ADMIN') {
          await this.lockAdministrators(tx, viewer);
          hold = await this.adminHold(tx, viewer, null);
        }
        const user = await tx.user.create({
          data: {
            companyId: viewer.companyId,
            email: normalizeEmail(body.email),
            fullName: body.fullName,
            role: body.role,
            employeeId,
            passwordHash: null, // The person chooses it with their one-time link.
            ...hold?.columns,
          },
        });
        const passwordSetup = await this.accounts.issuePasswordSetup(user.id, tx);
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'user.created',
            entityType: 'user',
            entityId: user.id,
            detail: { role: user.role, employeeId, ...hold?.auditDetail },
          },
          tx,
        );
        return { user: toUserAccount(user), passwordSetup };
      });
    } catch (error) {
      throw duplicateToConflict(error);
    }
  }

  async update(viewer: SignedInUser, userId: string, body: UpdateUserBody): Promise<UserAccount> {
    const changedFields = Object.keys(body);
    if (userId === viewer.userId && changedFields.some((field) => field !== 'fullName')) {
      throw new ConflictException(
        'On your own account you can only change your name. Ask another administrator.',
      );
    }
    // The link rule is checked on the result: the body over the stored row.
    // Checks that read other modules run before the transaction, so it never
    // waits on a second database connection while it holds its locks.
    const current = await this.findInCompany(viewer, userId);
    const role = body.role ?? current.role;
    const employeeId = body.employeeId === undefined ? current.employeeId : body.employeeId;
    assertLinkFits(role, employeeId);
    if (employeeId !== null && employeeId !== current.employeeId) {
      await this.assertEmployeeCanBeLinked(viewer, employeeId);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await this.lockForChange(tx, viewer, userId);
        if (!target.isActive) {
          throw new ConflictException('This account is switched off. Reactivate it first.');
        }
        if (target.role !== current.role || target.employeeId !== current.employeeId) {
          throw new ConflictException(
            'This account changed a moment ago. Load it again and retry.',
          );
        }
        // Becoming an ADMIN waits for a second administrator; leaving the
        // role clears the record, which the database insists on.
        const promoted = role === 'ADMIN' && target.role !== 'ADMIN';
        const hold = promoted ? await this.adminHold(tx, viewer, target.id) : undefined;

        const updated = await tx.user.update({
          where: { id: target.id },
          data: {
            ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
            ...(body.email !== undefined ? { email: normalizeEmail(body.email) } : {}),
            role,
            employeeId,
            ...(hold?.columns ?? (role !== 'ADMIN' ? NOT_AN_ADMIN : {})),
          },
        });
        // The token carries the role and link, so changing either ends every
        // session: the person signs in again with their new access.
        if (role !== target.role || employeeId !== target.employeeId) {
          await this.accounts.endAllAccess(target.id, tx);
        }
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            // Only WHICH fields changed — never their values.
            action: 'user.updated',
            entityType: 'user',
            entityId: target.id,
            detail: { changedFields: changedFields.join(','), ...hold?.auditDetail },
          },
          tx,
        );
        return toUserAccount(updated);
      });
    } catch (error) {
      throw duplicateToConflict(error);
    }
  }

  async deactivate(viewer: SignedInUser, userId: string): Promise<UserAccount> {
    assertNotSelf(viewer, userId, 'switch off');
    return this.prisma.$transaction(async (tx) => {
      const target = await this.lockForChange(tx, viewer, userId);
      if (!target.isActive) {
        throw new ConflictException('This account is already switched off.');
      }
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { isActive: false },
      });
      await this.accounts.endAllAccess(target.id, tx);
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'user.deactivated',
          entityType: 'user',
          entityId: target.id,
          detail: { reason: 'BY_ADMIN' },
        },
        tx,
      );
      return toUserAccount(updated);
    });
  }

  async reactivate(viewer: SignedInUser, userId: string): Promise<UserAccount> {
    assertNotSelf(viewer, userId, 'switch on');
    // A switched-off account's link cannot change (updates are refused), so
    // the leaver check can safely run before the transaction.
    const current = await this.findInCompany(viewer, userId);
    if (current.employeeId) {
      const employee = await this.employees.get(viewer, current.employeeId);
      if (employee.status === 'TERMINATED') {
        throw new ConflictException(
          'This account belongs to an employee who has left the company.',
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const target = await this.lockForChange(tx, viewer, userId);
      if (target.isActive) {
        throw new ConflictException('This account is already switched on.');
      }
      // An old ADMIN account coming back is an administrator appearing: it
      // waits for a second one like a new account does.
      const hold =
        target.role === 'ADMIN' ? await this.adminHold(tx, viewer, target.id, true) : undefined;
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { isActive: true, ...hold?.columns },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'user.reactivated',
          entityType: 'user',
          entityId: target.id,
          ...(hold ? { detail: hold.auditDetail } : {}),
        },
        tx,
      );
      return toUserAccount(updated);
    });
  }

  /**
   * Clears the password AND the authenticator, ends every session and issues
   * a new one-time link. Both go together on purpose: resetting only the
   * authenticator would let someone who stole the password ask for "a new
   * phone" and enrol their own.
   */
  async resetSignIn(viewer: SignedInUser, userId: string): Promise<UserAccountWithPasswordSetup> {
    assertNotSelf(viewer, userId, 'reset');
    const { result, email } = await this.prisma.$transaction(async (tx) => {
      const target = await this.lockForChange(tx, viewer, userId);
      if (!target.isActive) {
        throw new ConflictException('This account is switched off. Reactivate it first.');
      }
      // Whoever holds the new link holds the account, so a reset ADMIN
      // waits for a second administrator too.
      const hold =
        target.role === 'ADMIN' ? await this.adminHold(tx, viewer, target.id, true) : undefined;
      const updated = await tx.user.update({
        where: { id: target.id },
        data: {
          passwordHash: null,
          twoFactorSecretEncrypted: null,
          twoFactorEnabledAt: null,
          twoFactorLastUsedStep: null,
          ...hold?.columns,
        },
      });
      await this.accounts.endAllAccess(target.id, tx);
      const passwordSetup = await this.accounts.issuePasswordSetup(target.id, tx);
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'user.sign_in_reset',
          entityType: 'user',
          entityId: target.id,
          ...(hold ? { detail: hold.auditDetail } : {}),
        },
        tx,
      );
      return { result: { user: toUserAccount(updated), passwordSetup }, email: updated.email };
    });
    // Old lockouts must not stop the rightful owner using their new link.
    await this.throttle.recordSuccess('password', email);
    await this.throttle.recordSuccess('totp', userId);
    return result;
  }

  /**
   * The second half of every ADMIN account change: a different administrator
   * says the account belongs to the person it names. Never the one who made
   * the change and never the account itself — the service refuses both with
   * a plain message, and a database CHECK refuses them whatever the service
   * does.
   */
  async confirmAdmin(viewer: SignedInUser, userId: string): Promise<UserAccount> {
    assertNotSelf(viewer, userId, 'confirm');
    return this.prisma.$transaction(async (tx) => {
      const target = await this.lockForChange(tx, viewer, userId);
      if (!target.isActive || !awaitsAdminConfirmation(target)) {
        throw new ConflictException('This account is not waiting for a second administrator.');
      }
      if (target.adminRequestedByUserId === viewer.userId) {
        throw new ConflictException(
          'You made this change, so another administrator must confirm it.',
        );
      }
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { adminConfirmedByUserId: viewer.userId, adminConfirmedAt: new Date() },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'user.admin_confirmed',
          entityType: 'user',
          entityId: target.id,
        },
        tx,
      );
      return toUserAccount(updated);
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * What an ADMIN account change writes: who asked and when, and sometimes an
   * immediate confirmation naming nobody (docs/plan/06, rule 4).
   *
   * **That shortcut is only for a company gaining an administrator** — a new
   * account or a promotion — while the requester is the only usable
   * administrator there is. Without it a one-administrator company could
   * never get its second one except through the rescue script.
   *
   * **It never applies to an account that is already an administrator.**
   * Resetting one, or switching one back on, is exactly the move this rule
   * exists to catch: in a company of two the other administrator is the one
   * being changed, so counting only the requester would wave through
   * precisely the case where one person ends up holding both accounts. Those
   * wait for a third administrator, or for
   * `pnpm --filter @samtec/api account:admin`, which needs database access.
   *
   * Callers take `lockAdministrators` (or `lockForChange`, which the
   * administrators' rows include) first, so two administrators cannot each
   * count the other as present while both are being changed.
   */
  private async adminHold(
    tx: Prisma.TransactionClient,
    viewer: SignedInUser,
    targetId: string | null,
    alreadyAnAdministrator = false,
  ): Promise<{
    columns: {
      adminRequestedByUserId: string;
      adminRequestedAt: Date;
      adminConfirmedByUserId: null;
      adminConfirmedAt: Date | null;
    };
    auditDetail: { adminConfirmation: 'AWAITING' | 'SOLE_ADMINISTRATOR' };
  }> {
    const now = new Date();
    const administrators = await tx.user.findMany({
      where: {
        companyId: viewer.companyId,
        role: 'ADMIN',
        isActive: true,
        ...(targetId ? { id: { not: targetId } } : {}),
      },
      select: {
        id: true,
        isActive: true,
        passwordHash: true,
        role: true,
        twoFactorEnabledAt: true,
        adminRequestedAt: true,
        adminConfirmedAt: true,
      },
    });
    const usable = administrators.filter((account) => mayUseAccount(account));
    const soleAdministrator =
      !alreadyAnAdministrator && usable.length === 1 && usable[0]?.id === viewer.userId;
    return {
      columns: {
        adminRequestedByUserId: viewer.userId,
        adminRequestedAt: now,
        adminConfirmedByUserId: null,
        adminConfirmedAt: soleAdministrator ? now : null,
      },
      auditDetail: {
        adminConfirmation: soleAdministrator ? 'SOLE_ADMINISTRATOR' : 'AWAITING',
      },
    };
  }

  /**
   * Locks every ADMIN row of the company before an ADMIN account is created,
   * in ID order like `lockForChange`, and re-checks the viewer. Creating has
   * no target row to lock, and without this two administrators creating
   * accounts at the same instant could each count themselves as the only one.
   */
  private async lockAdministrators(
    tx: Prisma.TransactionClient,
    viewer: SignedInUser,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE company_id = ${viewer.companyId}::uuid AND (role = 'ADMIN' OR id = ${viewer.userId}::uuid) ORDER BY id FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: viewer.userId } });
    if (!actor || !mayUseAccount(actor) || actor.role !== 'ADMIN') {
      throw new UnauthorizedException('Sign in to continue.');
    }
  }

  /**
   * Starts every change to an existing account. It locks the administrator's
   * row and the target's row, always in the same order (by ID), then checks
   * the administrator is still an active ADMIN. So if two administrators try
   * to switch each other off at the same instant, one waits for the other —
   * and the second is refused, because their own account was just switched
   * off. The company can never be left without an administrator.
   *
   * Prisma has no "lock these rows" method, so this is one line of SQL,
   * written as a tagged template so every value is sent as a parameter.
   */
  private async lockForChange(
    tx: Prisma.TransactionClient,
    viewer: SignedInUser,
    targetId: string,
  ): Promise<User> {
    // Every administrator's row as well as the two involved: an ADMIN change
    // counts the company's administrators (`adminHold`), and that count must
    // not move underneath it.
    await tx.$queryRaw`SELECT id FROM users WHERE company_id = ${viewer.companyId}::uuid AND (id IN (${viewer.userId}::uuid, ${targetId}::uuid) OR role = 'ADMIN') ORDER BY id FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: viewer.userId } });
    if (!actor || !mayUseAccount(actor) || actor.role !== 'ADMIN') {
      throw new UnauthorizedException('Sign in to continue.');
    }
    const target = await tx.user.findFirst({
      where: { id: targetId, companyId: viewer.companyId },
    });
    if (!target) {
      throw new NotFoundException(NO_SUCH_ACCOUNT);
    }
    return target;
  }

  private async findInCompany(viewer: SignedInUser, userId: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, companyId: viewer.companyId },
    });
    if (!user) {
      throw new NotFoundException(NO_SUCH_ACCOUNT);
    }
    return user;
  }

  /**
   * The employee must belong to this company and not have left. Accepted,
   * tiny window: if HR records the leave in the very same instant as this
   * link, the account can stay on — an administrator then switches it off.
   */
  private async assertEmployeeCanBeLinked(viewer: SignedInUser, employeeId: string): Promise<void> {
    const employee = await this.employees.get(viewer, employeeId).catch((error: unknown) => {
      if (error instanceof NotFoundException) {
        throw fieldProblem('employeeId', 'No employee exists with this ID.');
      }
      throw error;
    });
    if (employee.status === 'TERMINATED') {
      throw new ConflictException('This employee has left the company.');
    }
  }
}

const NO_SUCH_ACCOUNT = 'No user account exists with this ID.';

/** Leaving the ADMIN role clears its confirmation record (a database CHECK). */
const NOT_AN_ADMIN = {
  adminRequestedByUserId: null,
  adminRequestedAt: null,
  adminConfirmedByUserId: null,
  adminConfirmedAt: null,
} as const;

/** Maps a database user to the contract's `UserAccount`. Never includes a hash or secret. */
export function toUserAccount(user: User): UserAccount {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: accountStatus(user),
    twoFactorEnabled: user.twoFactorEnabledAt !== null,
    employeeId: user.employeeId,
    adminConfirmation:
      user.role === 'ADMIN' && user.adminRequestedAt
        ? {
            requestedByUserId: user.adminRequestedByUserId,
            requestedAt: user.adminRequestedAt.toISOString(),
            confirmedByUserId: user.adminConfirmedByUserId,
            confirmedAt: user.adminConfirmedAt?.toISOString() ?? null,
          }
        : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function assertLinkFits(role: User['role'], employeeId: string | null): void {
  const problem = employeeLinkProblem(role, employeeId);
  if (problem) {
    throw fieldProblem('employeeId', problem);
  }
}

function assertNotSelf(viewer: SignedInUser, userId: string, verb: string): void {
  if (userId === viewer.userId) {
    throw new ConflictException(`You cannot ${verb} your own account. Ask another administrator.`);
  }
}

function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}

/** Two accounts with one email, or two accounts for one employee, are clear 409s. */
function duplicateToConflict(error: unknown): unknown {
  if (isUniqueViolation(error, 'employee_id')) {
    return new ConflictException('This employee already has a sign-in account.');
  }
  if (isUniqueViolation(error, 'email')) {
    return new ConflictException('An account with this email already exists.');
  }
  return error;
}
