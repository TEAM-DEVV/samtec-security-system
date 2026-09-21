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
import { accountStatus, employeeLinkProblem, mayUseAccount } from './account-rules.js';
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
    const user = await this.prisma.user.findFirst({
      where: { id: userId, companyId: viewer.companyId },
    });
    if (!user) {
      throw new NotFoundException(NO_SUCH_ACCOUNT);
    }
    return toUserAccount(user);
  }

  async create(viewer: SignedInUser, body: CreateUserBody): Promise<UserAccountWithPasswordSetup> {
    const employeeId = body.employeeId ?? null;
    assertLinkFits(body.role, employeeId);
    if (employeeId) {
      await this.assertEmployeeCanBeLinked(viewer, employeeId);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            companyId: viewer.companyId,
            email: normalizeEmail(body.email),
            fullName: body.fullName,
            role: body.role,
            employeeId,
            passwordHash: null, // The person chooses it with their one-time link.
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
            detail: { role: user.role, employeeId },
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
    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await this.lockForChange(tx, viewer, userId);
        if (!target.isActive) {
          throw new ConflictException('This account is switched off. Reactivate it first.');
        }
        // The link rule is checked on the result: the body over the stored row.
        const role = body.role ?? target.role;
        const employeeId = body.employeeId === undefined ? target.employeeId : body.employeeId;
        assertLinkFits(role, employeeId);
        if (employeeId !== null && employeeId !== target.employeeId) {
          await this.assertEmployeeCanBeLinked(viewer, employeeId);
        }

        const updated = await tx.user.update({
          where: { id: target.id },
          data: {
            ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
            ...(body.email !== undefined ? { email: normalizeEmail(body.email) } : {}),
            role,
            employeeId,
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
            detail: { changedFields: changedFields.join(',') },
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
    return this.prisma.$transaction(async (tx) => {
      const target = await this.lockForChange(tx, viewer, userId);
      if (target.isActive) {
        throw new ConflictException('This account is already switched on.');
      }
      if (target.employeeId) {
        const employee = await this.employees.get(viewer, target.employeeId);
        if (employee.status === 'TERMINATED') {
          throw new ConflictException(
            'This account belongs to an employee who has left the company.',
          );
        }
      }
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { isActive: true },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'user.reactivated',
          entityType: 'user',
          entityId: target.id,
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
      const updated = await tx.user.update({
        where: { id: target.id },
        data: {
          passwordHash: null,
          twoFactorSecretEncrypted: null,
          twoFactorEnabledAt: null,
          twoFactorLastUsedStep: null,
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

  // ---------------------------------------------------------------------------

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
    await tx.$queryRaw`SELECT id FROM users WHERE id IN (${viewer.userId}::uuid, ${targetId}::uuid) ORDER BY id FOR UPDATE`;
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

  /** The employee must belong to this company and not have left. */
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
