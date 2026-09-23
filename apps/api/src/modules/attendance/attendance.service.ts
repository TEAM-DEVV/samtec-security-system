import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AttendanceException as ApiException,
  WorkSegment as ApiSegment,
  AttendanceExceptionList,
  ClockInAttemptList,
  EmployeeRef,
  ExceptionResolutionAction,
  PunchFeedList,
  WorkSegmentList,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { fromIsoDate, toAccraDate, toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { hasDatabaseCode } from '../../common/prisma-errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, WorkSegment } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import { SitesService } from '../workforce/sites.service.js';
import type {
  ListAttemptsQuery,
  ListExceptionsQuery,
  ListPunchesQuery,
  ListSegmentsQuery,
  ResolveExceptionBody,
} from './attendance.schemas.js';
import {
  ATTENDANCE_TRANSACTION_OPTIONS,
  AttendanceBusyException,
  isLockTimeout,
  lockCompanyAttendance,
} from './attendance-lock.js';
import { MAX_SHIFT_MS } from './pairing.js';
import { PairingService } from './pairing.service.js';

/** Which resolutions fit which exception type (docs/plan/12 §5). */
const ACTIONS_FOR_TYPE: Record<ApiException['type'], ExceptionResolutionAction[]> = {
  MISSING_CLOCK_OUT: ['DISMISS', 'ADD_SEGMENT'],
  MISSING_CLOCK_IN: ['DISMISS', 'ADD_SEGMENT'],
  UNKNOWN_EMPLOYEE: ['DISMISS'],
  INACTIVE_EMPLOYEE: ['DISMISS'],
  OVERLAP: ['KEEP_SEGMENT', 'VOID_ALL'],
  // A terminal reported a finger nobody asked for. Nothing here to add or
  // keep: the finger was never taken, so an ADMIN reads it and dismisses it.
  UNEXPECTED_DEVICE_ENROLLMENT: ['DISMISS'],
};

const exceptionInclude = {
  punch: { include: { device: { select: { name: true } } } },
  segment: true,
  secondSegment: true,
} satisfies Prisma.AttendanceExceptionInclude;
type ExceptionRow = Prisma.AttendanceExceptionGetPayload<{ include: typeof exceptionInclude }>;

/**
 * Reading worked shifts and the exception queue, and resolving exceptions.
 * Scoping follows the workforce rules: ADMIN and HR_PAYROLL see the whole
 * company, a SUPERVISOR their own sites, a GUARD only themselves; anything
 * hidden answers 404. Reads never write. Contract: the `Attendance` operations.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly sites: SitesService,
    private readonly pairing: PairingService,
  ) {}

  async listSegments(viewer: SignedInUser, query: ListSegmentsQuery): Promise<WorkSegmentList> {
    // The workforce rules decide whether the caller may see this site or person (404 if not).
    if (query.siteId) await this.sites.get(viewer, query.siteId);
    if (query.employeeId) await this.employees.get(viewer, query.employeeId);
    const after = readCursor(query.cursor);
    const visible = await this.sites.visibleSiteIds(viewer);
    const guardSelf = viewer.employeeId;
    if (viewer.role === 'GUARD' && !guardSelf) {
      return { items: [], nextCursor: null };
    }

    const where: Prisma.WorkSegmentWhereInput = {
      companyId: viewer.companyId,
      workDate: { gte: fromIsoDate(query.from), lte: fromIsoDate(query.to) },
      status: query.status ?? { in: ['CONFIRMED', 'DISPUTED'] },
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      AND: [
        viewer.role === 'GUARD' && guardSelf
          ? { employeeId: guardSelf }
          : visible
            ? { siteId: { in: visible } }
            : {},
        after
          ? {
              OR: [{ startedAt: { gt: after.at } }, { startedAt: after.at, id: { gt: after.id } }],
            }
          : {},
      ],
    };
    const rows = await this.prisma.workSegment.findMany({
      where,
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) =>
      cursorOf(row.startedAt, row.id),
    );
    const refs = await this.employees.refsByIds(
      viewer.companyId,
      pageRows.map((row) => row.employeeId),
    );
    return { items: pageRows.map((row) => toApiSegment(row, refs)), nextCursor };
  }

  async listExceptions(
    viewer: SignedInUser,
    query: ListExceptionsQuery,
  ): Promise<AttendanceExceptionList> {
    if (query.siteId) await this.sites.get(viewer, query.siteId);
    const after = readCursor(query.cursor);
    const visible = await this.sites.visibleSiteIds(viewer);

    const where: Prisma.AttendanceExceptionWhereInput = {
      companyId: viewer.companyId,
      status: query.status,
      ...(query.type ? { type: query.type } : {}),
      AND: [
        query.siteId ? { OR: [{ siteId: query.siteId }, { secondSiteId: query.siteId }] } : {},
        visible ? visibleExceptionsFilter(visible) : {},
        after
          ? {
              OR: [
                { occurredAt: { lt: after.at } },
                { occurredAt: after.at, id: { lt: after.id } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.prisma.attendanceException.findMany({
      where,
      include: exceptionInclude,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) =>
      cursorOf(row.occurredAt, row.id),
    );
    const refs = await this.refsFor(viewer.companyId, pageRows);
    return { items: pageRows.map((row) => toApiException(row, refs, viewer)), nextCursor };
  }

  async getException(viewer: SignedInUser, exceptionId: string): Promise<ApiException> {
    const visible = await this.sites.visibleSiteIds(viewer);
    const row = await this.findVisibleException(this.prisma, viewer, exceptionId, visible);
    return toApiException(row, await this.refsFor(viewer.companyId, [row]), viewer);
  }

  /**
   * Resolves one exception, under the company's attendance lock so it can
   * never race an ingest batch. Afterwards the person is re-paired, so the
   * segments' statuses and the queue stay consistent.
   */
  async resolve(
    viewer: SignedInUser,
    exceptionId: string,
    body: ResolveExceptionBody,
  ): Promise<ApiException> {
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockCompanyAttendance(tx, viewer.companyId);
        // Scope is read inside the lock, on the same connection: a supervisor
        // moved off a site a moment ago can no longer resolve its exceptions.
        const visible = await this.sites.visibleSiteIds(viewer, tx);
        const row = await this.findVisibleException(tx, viewer, exceptionId, visible);
        if (row.employeeId !== null && row.employeeId === viewer.employeeId) {
          throw new ForbiddenException(
            'Nobody may resolve an exception about their own attendance.',
          );
        }
        if (row.status !== 'OPEN') {
          throw new ConflictException('This exception has already been dealt with.');
        }
        if (!ACTIONS_FOR_TYPE[row.type].includes(body.action)) {
          throw fieldProblem(
            'action',
            `For this exception, choose one of ${ACTIONS_FOR_TYPE[row.type].join(', ')}.`,
          );
        }

        let resolutionSegmentId: string | null = null;
        let voided: string[] = [];
        if (body.action === 'ADD_SEGMENT') {
          resolutionSegmentId = await this.addManualSegment(tx, row, body, now);
        } else if (body.action === 'KEEP_SEGMENT' || body.action === 'VOID_ALL') {
          const pair = [row.segmentId, row.secondSegmentId];
          if (body.action === 'KEEP_SEGMENT' && !pair.includes(body.segmentId)) {
            throw fieldProblem('segmentId', "Choose one of this exception's two shifts.");
          }
          voided = pair.filter(
            (id): id is string =>
              id !== null && (body.action === 'VOID_ALL' || id !== body.segmentId),
          );
          // A person's void: re-pairing will never bring these back.
          await tx.workSegment.updateMany({
            where: { id: { in: voided }, status: { not: 'VOIDED' } },
            data: { status: 'VOIDED', voidedAt: now, voidedByUserId: viewer.userId },
          });
        }

        await tx.attendanceException.update({
          where: { id: row.id },
          data: {
            status: 'RESOLVED',
            resolutionAction: body.action,
            resolutionNote: body.note,
            resolvedByUserId: viewer.userId,
            resolvedAt: now,
            resolutionSegmentId,
          },
        });
        // The note stays on the exception, never in the audit log (it is free text).
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'attendance.exception_resolved',
            entityType: 'attendance_exception',
            entityId: row.id,
            detail: {
              type: row.type,
              resolution: body.action,
              ...(body.action === 'KEEP_SEGMENT' ? { keptSegmentId: body.segmentId } : {}),
              ...(body.action === 'KEEP_SEGMENT' || body.action === 'VOID_ALL'
                ? { voidedSegmentIds: voided.join(',') }
                : {}),
              ...(resolutionSegmentId ? { addedSegmentId: resolutionSegmentId } : {}),
            },
          },
          tx,
        );
        // A dismissal changes no shift, so only the other actions re-pair the person.
        if (row.employeeId && body.action !== 'DISMISS') {
          await this.pairing.repair(tx, viewer.companyId, [row.employeeId], now);
        }
      }, ATTENDANCE_TRANSACTION_OPTIONS);
    } catch (error) {
      if (isLockTimeout(error)) throw new AttendanceBusyException();
      // Defence in depth: the check inside the lock already refuses overlaps, but if a
      // future change ever let one through, the database refuses it when the
      // transaction commits (exclusion constraint, SQLSTATE 23P01), and the caller gets a 409.
      if (hasDatabaseCode(error, '23P01')) {
        throw new ConflictException('These hours overlap another shift of this employee.');
      }
      throw error;
    }
    return this.getException(viewer, exceptionId);
  }

  /**
   * ADD_SEGMENT: hours completed by hand, only ever around real evidence. The
   * window must contain the punch's time, last at most 16 hours, end in the
   * past, and not overlap another live shift of the person.
   */
  private async addManualSegment(
    tx: Prisma.TransactionClient,
    row: ExceptionRow,
    body: Extract<ResolveExceptionBody, { action: 'ADD_SEGMENT' }>,
    now: Date,
  ): Promise<string> {
    const startedAt = new Date(body.startedAt);
    const endedAt = new Date(body.endedAt);
    if (!row.punch || !row.employeeId) {
      throw new Error('A missing-punch exception always has its punch and employee');
    }
    if (endedAt <= startedAt) throw fieldProblem('endedAt', 'The end must come after the start.');
    if (endedAt.getTime() - startedAt.getTime() > MAX_SHIFT_MS) {
      throw fieldProblem('endedAt', 'A shift can be at most 16 hours long.');
    }
    if (endedAt > now) throw fieldProblem('endedAt', 'The end cannot be in the future.');
    if (row.punch.deviceTime < startedAt || row.punch.deviceTime > endedAt) {
      throw fieldProblem('startedAt', "The hours must include the real punch's time.");
    }
    const clash = await tx.workSegment.findFirst({
      where: {
        employeeId: row.employeeId,
        status: { in: ['CONFIRMED', 'DISPUTED'] },
        startedAt: { lt: endedAt },
        endedAt: { gt: startedAt },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException('These hours overlap another shift of this employee.');
    }
    const segment = await tx.workSegment.create({
      data: {
        companyId: row.companyId,
        employeeId: row.employeeId,
        siteId: row.siteId,
        workDate: fromIsoDate(toAccraDate(startedAt)),
        startedAt,
        endedAt,
        workedMinutes: Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000),
        basis: 'MANUAL',
        status: 'CONFIRMED',
      },
      select: { id: true },
    });
    return segment.id;
  }

  private async findVisibleException(
    db: Prisma.TransactionClient,
    viewer: SignedInUser,
    exceptionId: string,
    visible: string[] | undefined,
  ): Promise<ExceptionRow> {
    const row = await db.attendanceException.findFirst({
      where: {
        id: exceptionId,
        companyId: viewer.companyId,
        ...(visible ? visibleExceptionsFilter(visible) : {}),
      },
      include: exceptionInclude,
    });
    if (!row) {
      throw new NotFoundException('No exception exists with this ID.');
    }
    return row;
  }

  /** Names for everyone a page of exceptions mentions, in one query. */
  private refsFor(companyId: string, rows: ExceptionRow[]): Promise<Map<string, EmployeeRef>> {
    return this.employees.refsByIds(
      companyId,
      rows
        .flatMap((row) => [
          row.employeeId,
          row.segment?.employeeId ?? null,
          row.secondSegment?.employeeId ?? null,
        ])
        .filter((id): id is string => id !== null),
    );
  }

  /**
   * The live clock-ins board: every punch from every device, newest first by
   * the time the API received it, so the dashboard can refresh every few
   * seconds and see a shift change happening.
   *
   * Newest-first by **server** time, not device time, because that is the
   * order things really reached us: a terminal with a wrong clock cannot
   * push itself to the top of somebody's screen.
   */
  async listPunches(viewer: SignedInUser, query: ListPunchesQuery): Promise<PunchFeedList> {
    // The workforce rules decide whether this caller may see this site (404 if not).
    if (query.siteId) await this.sites.get(viewer, query.siteId);
    const after = readCursor(query.cursor);
    const visible = await this.sites.visibleSiteIds(viewer);

    const rows = await this.prisma.punchEvent.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.since ? { serverTime: { gte: new Date(query.since) } } : {}),
        AND: [
          visible ? { siteId: { in: visible } } : {},
          after
            ? {
                OR: [
                  { serverTime: { lt: after.at } },
                  { serverTime: after.at, id: { lt: after.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { device: { select: { name: true } } },
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) =>
      cursorOf(row.serverTime, row.id),
    );
    const refs = await this.employees.refsByIds(
      viewer.companyId,
      pageRows.flatMap((row) => (row.employeeId ? [row.employeeId] : [])),
    );
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        employee: row.employeeId ? (refs.get(row.employeeId) ?? null) : null,
        deviceUserRef: row.deviceUserRef,
        siteId: row.siteId,
        deviceId: row.deviceId,
        deviceName: row.device.name,
        deviceTime: row.deviceTime.toISOString(),
        serverTime: row.serverTime.toISOString(),
        direction: row.direction,
        method: row.method,
        // A punch nobody could pair is as suspect as one with a bad clock:
        // the board shows both the same way.
        clockSuspect: row.clockSuspect || !row.pairable,
      })),
      nextCursor,
    };
  }

  /**
   * What the kiosks have been asked, successes and failures alike (ADMIN).
   *
   * This is the anti-probing control made visible: somebody holding up
   * photographs, or trying staff numbers one after another, shows up here as
   * a run of failures from one device. Scores never leave the server, so the
   * list carries outcomes, not numbers.
   */
  async listAttempts(viewer: SignedInUser, query: ListAttemptsQuery): Promise<ClockInAttemptList> {
    const after = readCursor(query.cursor);
    const rows = await this.prisma.clockInAttempt.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(after
          ? {
              OR: [
                { attemptedAt: { lt: after.at } },
                { attemptedAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { device: { select: { name: true } } },
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) =>
      cursorOf(row.attemptedAt, row.id),
    );
    const refs = await this.employees.refsByIds(
      viewer.companyId,
      pageRows.flatMap((row) =>
        [row.employeeId, row.coSignForEmployeeId].filter((id): id is string => id !== null),
      ),
    );
    // An attempt never changes once it is written, so it has no "was this
    // confirmed?" column: the punch it led to carries its id, and that one
    // link is also what makes a second confirmation a DUPLICATE.
    const punches = await this.prisma.punchEvent.findMany({
      where: {
        companyId: viewer.companyId,
        // The same device: another device's event that happens to carry
        // this id is not this attempt's punch.
        deviceId: { in: [...new Set(pageRows.map((row) => row.deviceId))] },
        deviceEventId: { in: pageRows.map((row) => row.id) },
      },
      select: { id: true, deviceId: true, deviceEventId: true },
    });
    const punchOf = new Map(
      punches.map((punch) => [`${punch.deviceId}|${punch.deviceEventId}`, punch.id]),
    );
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        deviceName: row.device.name,
        purpose: row.purpose,
        direction: row.direction === 'OUT' ? ('OUT' as const) : ('IN' as const),
        outcome: row.outcome,
        staffNumberTried: row.staffNumberTried,
        employee: row.employeeId ? (refs.get(row.employeeId) ?? null) : null,
        coSignFor: row.coSignForEmployeeId ? (refs.get(row.coSignForEmployeeId) ?? null) : null,
        cancelsAttemptId: row.cancelsAttemptId,
        attemptedAt: row.attemptedAt.toISOString(),
        punchId: punchOf.get(`${row.deviceId}|${row.id}`) ?? null,
      })),
      nextCursor,
    };
  }
}

/** A supervisor sees an exception only when every site it touches is theirs. */
function visibleExceptionsFilter(siteIds: string[]): Prisma.AttendanceExceptionWhereInput {
  return {
    siteId: { in: siteIds },
    OR: [{ secondSiteId: null }, { secondSiteId: { in: siteIds } }],
  };
}

/** Pages are sorted by a moment and then the ID, so the cursor holds both. */
function cursorOf(at: Date, id: string): string {
  return `${at.toISOString()}|${id}`;
}

function readCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const [at = '', id = ''] = (decodeCursor(cursor) ?? '').split('|');
  const moment = new Date(at);
  if (Number.isNaN(moment.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw fieldProblem('cursor', 'The cursor is not valid. Start again from the first page.');
  }
  return { at: moment, id };
}

function refOf(refs: Map<string, EmployeeRef>, employeeId: string): EmployeeRef {
  const ref = refs.get(employeeId);
  if (!ref) {
    throw new Error(`Employee ${employeeId} was not found for an attendance record`);
  }
  return ref;
}

function toApiSegment(row: WorkSegment, refs: Map<string, EmployeeRef>): ApiSegment {
  return {
    id: row.id,
    employee: refOf(refs, row.employeeId),
    siteId: row.siteId,
    workDate: toIsoDate(row.workDate),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    workedMinutes: row.workedMinutes,
    basis: row.basis,
    status: row.status,
    clockInPunchId: row.clockInPunchId,
    clockOutPunchId: row.clockOutPunchId,
  };
}

/** `allowedActions` depends on who asks: HR and the person themselves get none. */
function toApiException(
  row: ExceptionRow,
  refs: Map<string, EmployeeRef>,
  viewer: SignedInUser,
): ApiException {
  const mayResolve =
    row.status === 'OPEN' &&
    (viewer.role === 'ADMIN' || viewer.role === 'SUPERVISOR') &&
    (row.employeeId === null || row.employeeId !== viewer.employeeId);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    siteId: row.siteId,
    secondSiteId: row.secondSiteId,
    employee: row.employeeId ? refOf(refs, row.employeeId) : null,
    workDate: toIsoDate(row.workDate),
    occurredAt: row.occurredAt.toISOString(),
    punch: row.punch
      ? {
          id: row.punch.id,
          deviceId: row.punch.deviceId,
          deviceName: row.punch.device.name,
          deviceUserRef: row.punch.deviceUserRef,
          deviceTime: row.punch.deviceTime.toISOString(),
          serverTime: row.punch.serverTime.toISOString(),
          direction: row.punch.direction,
          method: row.punch.method,
          clockSuspect: row.punch.clockSuspect || !row.punch.pairable,
        }
      : null,
    segments: [row.segment, row.secondSegment]
      .filter((segment): segment is WorkSegment => segment !== null)
      .map((segment) => toApiSegment(segment, refs)),
    resolution:
      row.status === 'RESOLVED' && row.resolutionAction && row.resolvedAt && row.resolvedByUserId
        ? {
            action: row.resolutionAction,
            note: row.resolutionNote ?? '',
            resolvedAt: row.resolvedAt.toISOString(),
            resolvedByUserId: row.resolvedByUserId,
          }
        : null,
    resolutionSegmentId: row.resolutionSegmentId,
    allowedActions: mayResolve ? ACTIONS_FOR_TYPE[row.type] : [],
    createdAt: row.createdAt.toISOString(),
  };
}

function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}
