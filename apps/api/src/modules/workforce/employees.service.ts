import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Employee as ApiEmployee, EmployeeList, EmployeeRef } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { EmployeeStatus } from '../../generated/prisma/enums.js';
import { AccountsService } from '../identity/accounts.service.js';
import { AuditService } from '../identity/audit.service.js';
import { fullNameOf, toEmployeeDetail, toEmployeeListItem } from './employee-mapping.js';
import {
  type CreateEmployeeBody,
  type ListEmployeesQuery,
  type TerminateEmployeeBody,
  toDatabaseDate,
  type UpdateEmployeeBody,
} from './workforce.schemas.js';

/** What attendance learns about the person behind a staff number. */
export interface StaffLookup {
  id: string;
  status: EmployeeStatus;
  /** YYYY-MM-DD, or null. */
  terminationDate: string | null;
}

/** An assignment that covers today: it has started and has not ended. */
export function currentAssignmentFilter(today: Date = new Date()) {
  return {
    startsOn: { lte: today },
    OR: [{ endsOn: null }, { endsOn: { gte: today } }],
  } satisfies Prisma.SiteAssignmentWhereInput;
}

/**
 * Reading and changing employees, with the contract's access rules built in:
 *
 * - ADMIN and HR_PAYROLL see every employee of the company.
 * - A SUPERVISOR sees only employees posted to the sites they are posted to.
 * - A GUARD may read only their own record; lists are not for them.
 * - Records a caller may not see answer 404, never 403, so nobody can
 *   discover which IDs exist.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async list(viewer: SignedInUser, query: ListEmployeesQuery): Promise<EmployeeList> {
    if (viewer.role === 'GUARD') {
      throw new ForbiddenException('Your role does not allow this action.');
    }

    const afterStaffNumber = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && afterStaffNumber === undefined) {
      throw new BadRequestException({
        message: [
          {
            path: ['cursor'],
            message: 'The cursor is not valid. Start again from the first page.',
          },
        ],
      });
    }

    // A supervisor's world is the sites they are currently posted to.
    let visibleSiteIds: string[] | undefined;
    if (viewer.role === 'SUPERVISOR') {
      visibleSiteIds = await this.supervisorSiteIds(viewer);
      if (visibleSiteIds.length === 0) {
        return { items: [], nextCursor: null };
      }
    }

    const postedTo = (siteIds: string[] | { equals: string }) => ({
      assignments: {
        some: {
          ...currentAssignmentFilter(),
          siteId: Array.isArray(siteIds) ? { in: siteIds } : siteIds.equals,
        },
      },
    });

    const where: Prisma.EmployeeWhereInput = {
      companyId: viewer.companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(afterStaffNumber ? { staffNumber: { gt: afterStaffNumber } } : {}),
      AND: [
        ...(query.siteId ? [postedTo({ equals: query.siteId })] : []),
        ...(visibleSiteIds ? [postedTo(visibleSiteIds)] : []),
        ...(query.search
          ? [
              {
                OR: [
                  { staffNumber: { contains: query.search, mode: 'insensitive' as const } },
                  { firstName: { contains: query.search, mode: 'insensitive' as const } },
                  { lastName: { contains: query.search, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };

    // One extra row tells us whether a next page exists (see common/pagination.ts).
    const rows = await this.prisma.employee.findMany({
      where,
      orderBy: { staffNumber: 'asc' },
      take: query.limit + 1,
      include: this.includeCurrentSite(),
    });

    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.staffNumber);
    return {
      items: pageRows.map((row) =>
        toEmployeeListItem({ employee: row, currentSite: row.assignments[0]?.site ?? null }),
      ),
      nextCursor,
    };
  }

  async get(viewer: SignedInUser, employeeId: string): Promise<ApiEmployee> {
    // A guard may only ask about themselves. Anything else "does not exist".
    if (viewer.role === 'GUARD' && viewer.employeeId !== employeeId) {
      throw new NotFoundException('No employee exists with this ID.');
    }

    const row = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId: viewer.companyId },
      include: this.includeCurrentSite(),
    });
    if (!row) {
      throw new NotFoundException('No employee exists with this ID.');
    }

    const currentSite = row.assignments[0]?.site ?? null;
    if (viewer.role === 'SUPERVISOR' && viewer.employeeId !== employeeId) {
      const visibleSiteIds = await this.supervisorSiteIds(viewer);
      if (!currentSite || !visibleSiteIds.includes(currentSite.id)) {
        throw new NotFoundException('No employee exists with this ID.');
      }
    }

    const includeGhanaCardNumber =
      viewer.role === 'ADMIN' || viewer.role === 'HR_PAYROLL' || viewer.employeeId === employeeId;
    return toEmployeeDetail(
      {
        employee: row,
        currentSite,
        currentPost: row.assignments[0]?.post ?? null,
        currentShiftPattern: row.assignments[0]?.shiftPattern ?? null,
      },
      includeGhanaCardNumber,
    );
  }

  /**
   * Registers a new employee. Contract: `createEmployee`. The API generates
   * the staff number; the record starts as PENDING_ENROLLMENT and cannot
   * clock in or be paid until biometrics are enrolled (Phase 3).
   *
   * Everything happens in one transaction — the employee, their first
   * employment period, their site posting and the audit entry are saved
   * together or not at all.
   */
  async create(viewer: SignedInUser, body: CreateEmployeeBody): Promise<ApiEmployee> {
    await this.assertSiteInCompany(viewer, body.siteId);
    await this.assertPostAtSite(viewer, body.postId, body.siteId);
    await this.assertShiftPatternInCompany(viewer, body.shiftPatternId);
    const hireDate = toDatabaseDate(body.hireDate);

    // A rare race (two people registering at once) can collide on the
    // generated staff number; the unique constraint catches it and we retry.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const employeeId = await this.prisma.$transaction(async (tx) => {
          const employee = await tx.employee.create({
            data: {
              companyId: viewer.companyId,
              staffNumber: await this.nextStaffNumber(tx, viewer.companyId),
              firstName: body.firstName,
              lastName: body.lastName,
              otherNames: body.otherNames ?? null,
              phone: body.phone,
              email: body.email ?? null,
              ghanaCardNumber: body.ghanaCardNumber,
              position: body.position,
              hireDate,
            },
          });
          await tx.employmentPeriod.create({
            data: {
              companyId: viewer.companyId,
              employeeId: employee.id,
              startsOn: hireDate,
            },
          });
          if (body.siteId) {
            await tx.siteAssignment.create({
              data: {
                companyId: viewer.companyId,
                employeeId: employee.id,
                siteId: body.siteId,
                postId: body.postId ?? null,
                shiftPatternId: body.shiftPatternId ?? null,
                startsOn: hireDate,
              },
            });
          }
          await this.audit.record(
            {
              companyId: viewer.companyId,
              actorUserId: viewer.userId,
              action: 'employee.created',
              entityType: 'employee',
              entityId: employee.id,
              detail: { staffNumber: employee.staffNumber, siteAssigned: body.siteId != null },
            },
            tx,
          );
          return employee.id;
        });
        // Reusing get() for the response is safe because only ADMIN and
        // HR_PAYROLL reach these writes, and get() never hides anything from
        // them. Revisit this if more roles are ever allowed to write.
        return this.get(viewer, employeeId);
      } catch (error) {
        if (isUniqueViolation(error, 'ghana_card_number')) {
          throw new ConflictException(
            'An employee with this Ghana Card number is already registered.',
          );
        }
        if (isUniqueViolation(error, 'staff_number') && attempt < 3) {
          continue; // Someone else took the number a heartbeat ago; try the next one.
        }
        throw error;
      }
    }
  }

  /**
   * Changes an employee's details. Contract: `updateEmployee`. Only the sent
   * fields change; the Ghana Card number can never be changed here. A
   * terminated employee's record is history and answers 409.
   */
  async update(
    viewer: SignedInUser,
    employeeId: string,
    body: UpdateEmployeeBody,
  ): Promise<ApiEmployee> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId: viewer.companyId },
    });
    if (!employee) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    if (employee.status === 'TERMINATED') {
      throw new ConflictException(
        'This employee has left the company. Their record is kept as history and cannot be changed.',
      );
    }
    if (body.siteId != null) {
      await this.assertSiteInCompany(viewer, body.siteId);
    }
    if (body.postId != null) {
      await this.assertPostAtSite(viewer, body.postId, body.siteId ?? undefined);
    }
    if (body.shiftPatternId != null) {
      await this.assertShiftPatternInCompany(viewer, body.shiftPatternId);
    }

    const { siteId, postId, shiftPatternId, ...fields } = body;
    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(fields).length > 0) {
        await tx.employee.update({ where: { id: employeeId }, data: fields });
      }
      // `siteId` present means a posting change: a new site, or null to unassign.
      if (siteId !== undefined) {
        await this.movePosting(tx, viewer.companyId, employeeId, siteId, {
          postId: postId ?? null,
          shiftPatternId: shiftPatternId ?? null,
        });
      }
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          // Only WHICH fields changed — never their values, which are personal data.
          action: 'employee.updated',
          entityType: 'employee',
          entityId: employeeId,
          detail: { changedFields: Object.keys(body).join(',') },
        },
        tx,
      );
    });
    return this.get(viewer, employeeId);
  }

  /**
   * Records that an employee has left. Contract: `terminateEmployee`. The
   * record is never deleted: status becomes TERMINATED, the employment
   * period and any site posting are closed, and history survives — the
   * ghost-detection engine (Phase 5) flags any later clock-in or pay.
   */
  async terminate(
    viewer: SignedInUser,
    employeeId: string,
    body: TerminateEmployeeBody,
  ): Promise<ApiEmployee> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId: viewer.companyId },
    });
    if (!employee) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    if (employee.status === 'TERMINATED') {
      throw new ConflictException('This employee has already been terminated.');
    }
    const effectiveDate = toDatabaseDate(body.effectiveDate);
    if (effectiveDate < employee.hireDate) {
      throw new BadRequestException({
        message: [
          {
            path: ['effectiveDate'],
            message: 'The last working day cannot be before the hire date.',
          },
        ],
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: employeeId },
        data: {
          status: 'TERMINATED',
          terminationDate: effectiveDate,
          terminationReason: body.reason,
          terminationNote: body.note ?? null,
        },
      });
      await tx.employmentPeriod.updateMany({
        where: { employeeId, endsOn: null },
        data: { endsOn: effectiveDate, terminationReason: body.reason },
      });
      await tx.siteAssignment.updateMany({
        where: { employeeId, endsOn: null },
        data: { endsOn: effectiveDate },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'employee.terminated',
          entityType: 'employee',
          entityId: employeeId,
          // The reason is a fixed word from a list; the free-text note is not audited.
          detail: { reason: body.reason },
        },
        tx,
      );
      // A leaver's sign-in account (if they have one) is switched off in the
      // same transaction, as soon as the leave is recorded.
      await this.accounts.deactivateForLeaver(tx, {
        companyId: viewer.companyId,
        employeeId,
        actorUserId: viewer.userId,
      });
    });
    return this.get(viewer, employeeId);
  }

  /**
   * For the attendance module: who each staff number belongs to, with just
   * what deciding "may this person clock in?" needs. A system lookup (no
   * signed-in viewer — punches come from devices), scoped to one company.
   * One query per batch of punches.
   */
  async findByStaffNumbers(
    companyId: string,
    staffNumbers: string[],
  ): Promise<Map<string, StaffLookup>> {
    if (staffNumbers.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.employee.findMany({
      where: { companyId, staffNumber: { in: staffNumbers } },
      select: { id: true, staffNumber: true, status: true, terminationDate: true },
    });
    return new Map(
      rows.map((row) => [
        row.staffNumber,
        {
          id: row.id,
          status: row.status,
          terminationDate: row.terminationDate ? toIsoDate(row.terminationDate) : null,
        },
      ]),
    );
  }

  /**
   * For the attendance module: the name and staff number of each employee,
   * to label work segments and exceptions. One query per page, scoped to one
   * company. The caller has already decided what the viewer may see.
   */
  async refsByIds(companyId: string, employeeIds: string[]): Promise<Map<string, EmployeeRef>> {
    const ids = [...new Set(employeeIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.employee.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, staffNumber: true, firstName: true, otherNames: true, lastName: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, staffNumber: row.staffNumber, fullName: fullNameOf(row) },
      ]),
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * The next free staff number for this company: SMT-00001, SMT-00002, …
   * Sorting the text works because the number part is always 5 digits, which
   * caps a company at 99,999 employees — far beyond any real guard force.
   */
  private async nextStaffNumber(tx: Prisma.TransactionClient, companyId: string): Promise<string> {
    const last = await tx.employee.findFirst({
      where: { companyId },
      orderBy: { staffNumber: 'desc' },
      select: { staffNumber: true },
    });
    const lastNumber = last ? Number(last.staffNumber.slice(4)) : 0;
    return `SMT-${String(lastNumber + 1).padStart(5, '0')}`;
  }

  /** Ends today any open posting, and opens one at the new site (or none for null). */
  private async movePosting(
    tx: Prisma.TransactionClient,
    companyId: string,
    employeeId: string,
    siteId: string | null,
    roster: { postId: string | null; shiftPatternId: string | null },
  ): Promise<void> {
    const today = toDatabaseDate(new Date().toISOString().slice(0, 10));
    // The old posting ends YESTERDAY so it no longer covers today — otherwise
    // the employee would appear on two sites at once until midnight.
    const yesterday = new Date(today.getTime() - 86_400_000);
    await tx.siteAssignment.updateMany({
      where: { employeeId, endsOn: null },
      data: { endsOn: yesterday },
    });
    if (siteId !== null) {
      await tx.siteAssignment.create({
        data: {
          companyId,
          employeeId,
          siteId,
          postId: roster.postId,
          shiftPatternId: roster.shiftPatternId,
          startsOn: today,
        },
      });
    }
  }

  /** The post must exist at exactly the site being assigned; anything else is a clear 400. */
  private async assertPostAtSite(
    viewer: SignedInUser,
    postId: string | undefined,
    siteId: string | undefined,
  ): Promise<void> {
    if (postId === undefined) {
      return;
    }
    const post = await this.prisma.post.findFirst({
      where: { id: postId, companyId: viewer.companyId, siteId },
      select: { id: true },
    });
    if (!post) {
      throw new BadRequestException({
        message: [{ path: ['postId'], message: 'No post with this ID exists at this site.' }],
      });
    }
  }

  /** The shift pattern must belong to this company; anything else is a clear 400. */
  private async assertShiftPatternInCompany(
    viewer: SignedInUser,
    shiftPatternId: string | undefined,
  ): Promise<void> {
    if (shiftPatternId === undefined) {
      return;
    }
    const pattern = await this.prisma.shiftPattern.findFirst({
      where: { id: shiftPatternId, companyId: viewer.companyId },
      select: { id: true },
    });
    if (!pattern) {
      throw new BadRequestException({
        message: [{ path: ['shiftPatternId'], message: 'No shift pattern exists with this ID.' }],
      });
    }
  }

  /** A posting must point at a real site of this company; anything else is a clear 400. */
  private async assertSiteInCompany(
    viewer: SignedInUser,
    siteId: string | undefined,
  ): Promise<void> {
    if (siteId === undefined) {
      return;
    }
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, companyId: viewer.companyId },
      select: { id: true },
    });
    if (!site) {
      throw new BadRequestException({
        message: [{ path: ['siteId'], message: 'No site exists with this ID.' }],
      });
    }
  }

  /**
   * Biometrics moved: the worker now has a face in use (docs/plan/13 section
   * 2). Only this module writes the employees table, so the attendance module
   * calls in instead of reaching across. A `PENDING_ENROLLMENT` worker becomes
   * `ACTIVE`; a `SUSPENDED` or `TERMINATED` one is left exactly as they are.
   */
  async markBiometricsEnrolled(
    companyId: string,
    employeeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<EmployeeStatus> {
    return this.moveForBiometrics(companyId, employeeId, tx, {
      biometricEnrolledAt: new Date(),
      activate: true,
    });
  }

  /**
   * The worker no longer has a face (a revoke, a withdrawal, a new enrollment
   * that has not passed yet, or a record blocked as a duplicate). An `ACTIVE`
   * worker goes back to `PENDING_ENROLLMENT` and is not paid for co-signed
   * hours until a second ADMIN settles it.
   */
  async clearBiometricsEnrolled(
    companyId: string,
    employeeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<EmployeeStatus> {
    return this.moveForBiometrics(companyId, employeeId, tx, {
      biometricEnrolledAt: null,
      activate: false,
    });
  }

  /**
   * An approved exemption: the worker may work without a face, so they become
   * `ACTIVE` with nothing enrolled. Every hour they work is then flagged,
   * because they clock in by a supervisor's co-sign.
   */
  async activateWithoutBiometrics(
    companyId: string,
    employeeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<EmployeeStatus> {
    return this.moveForBiometrics(companyId, employeeId, tx, { activate: true });
  }

  private async moveForBiometrics(
    companyId: string,
    employeeId: string,
    tx: Prisma.TransactionClient,
    change: { biometricEnrolledAt?: Date | null; activate: boolean },
  ): Promise<EmployeeStatus> {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { status: true },
    });
    if (!employee) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    // Biometrics only ever move a worker between these two states. Somebody
    // suspended or gone is never changed by anything biometric.
    const status =
      change.activate && employee.status === 'PENDING_ENROLLMENT'
        ? 'ACTIVE'
        : !change.activate && employee.status === 'ACTIVE'
          ? 'PENDING_ENROLLMENT'
          : employee.status;
    await tx.employee.update({
      where: { id: employeeId },
      data: {
        status,
        ...(change.biometricEnrolledAt === undefined
          ? {}
          : { biometricEnrolledAt: change.biometricEnrolledAt }),
      },
    });
    return status;
  }

  /**
   * What the biometric flows need to know about a worker (docs/plan/13). The
   * attendance module asks for this instead of reading the employees table,
   * and the Ghana Card number itself never leaves this module.
   */
  async forBiometrics(
    viewer: SignedInUser,
    employeeId: string,
  ): Promise<{ id: string; staffNumber: string; status: EmployeeStatus }> {
    const row = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId: viewer.companyId },
      select: { id: true, staffNumber: true, status: true },
    });
    if (!row) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    return row;
  }

  /**
   * True when these really are the last 4 digits of this worker's Ghana Card.
   * The ADMIN reads them off the card the worker is holding, so the right
   * person is in front of the kiosk; the full number never leaves the office.
   */
  async ghanaCardLast4Matches(
    viewer: SignedInUser,
    employeeId: string,
    last4: string,
  ): Promise<boolean> {
    const row = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId: viewer.companyId },
      select: { ghanaCardNumber: true },
    });
    if (!row) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    // Ghana Cards are written with dashes; only the digits count.
    const digits = row.ghanaCardNumber.replace(/\D/g, '');
    return digits.length >= 4 && digits.slice(-4) === last4;
  }

  /** The sites this supervisor is currently posted to (usually one). */
  private async supervisorSiteIds(viewer: SignedInUser): Promise<string[]> {
    if (!viewer.employeeId) {
      return [];
    }
    const assignments = await this.prisma.siteAssignment.findMany({
      where: { employeeId: viewer.employeeId, ...currentAssignmentFilter() },
      select: { siteId: true },
    });
    return assignments.map((assignment) => assignment.siteId);
  }

  private includeCurrentSite() {
    return {
      assignments: {
        where: currentAssignmentFilter(),
        include: { site: true, post: true, shiftPattern: true },
        take: 1,
      },
    } satisfies Prisma.EmployeeInclude;
  }
}
