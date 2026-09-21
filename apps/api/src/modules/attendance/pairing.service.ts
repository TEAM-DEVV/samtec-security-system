import { Injectable } from '@nestjs/common';
import { fromIsoDate, toAccraDate } from '../../common/dates.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  ATTENDANCE_TRANSACTION_OPTIONS,
  AttendanceBusyException,
  isLockTimeout,
  lockCompanyAttendance,
} from './attendance-lock.js';
import {
  MAX_SHIFT_MS,
  missingKey,
  newSegmentRef,
  overlapKey,
  PAIRING_WINDOW_DAYS,
  type PairablePunch,
  pairPunches,
  planExceptions,
  planSegments,
  type SegmentStatus,
  type StoredException,
  type StoredSegment,
} from './pairing.js';

const DAY_MS = 86_400_000;
/** How many people one heartbeat's overdue check re-pairs at most; the next heartbeat does the rest. */
const OVERDUE_PEOPLE_PER_HEARTBEAT = 20;

/**
 * Keeps work segments and the exception queue in line with the punches. The
 * rules themselves are the pure functions in `pairing.ts`; this service only
 * reads what they need and writes what they decide. docs/plan/12 §4–§6.
 */
@Injectable()
export class PairingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pairs these people's last 62 days again from scratch and brings their
   * segments and exceptions in line. Runs in the caller's transaction, which
   * must already hold the company's attendance lock.
   */
  async repair(
    tx: Prisma.TransactionClient,
    companyId: string,
    employeeIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const people = [...new Set(employeeIds)];
    if (people.length === 0) {
      return;
    }
    const windowStart = new Date(now.getTime() - PAIRING_WINDOW_DAYS * DAY_MS);

    // Every segment that could overlap the window: they all end inside it.
    const segments = await tx.workSegment.findMany({
      where: { companyId, employeeId: { in: people }, endedAt: { gte: windowStart } },
      select: {
        id: true,
        employeeId: true,
        siteId: true,
        startedAt: true,
        endedAt: true,
        basis: true,
        status: true,
        clockInPunchId: true,
        clockOutPunchId: true,
        voidedByUserId: true,
      },
    });
    // Punches already used by a segment older than the window stay with it.
    const frozenPunchIds = new Set(
      segments
        .filter((segment) => segment.startedAt < windowStart)
        .flatMap((segment) => [segment.clockInPunchId, segment.clockOutPunchId]),
    );
    const punches = (
      await tx.punchEvent.findMany({
        where: {
          companyId,
          employeeId: { in: people },
          pairable: true,
          deviceTime: { gte: windowStart },
        },
        select: {
          id: true,
          employeeId: true,
          siteId: true,
          deviceTime: true,
          direction: true,
          method: true,
        },
      })
    ).filter((punch) => !frozenPunchIds.has(punch.id));
    const exceptions = await tx.attendanceException.findMany({
      where: {
        companyId,
        employeeId: { in: people },
        type: { in: ['MISSING_CLOCK_OUT', 'MISSING_CLOCK_IN', 'OVERLAP'] },
        status: { in: ['OPEN', 'AUTO_CLOSED'] },
        occurredAt: { gte: windowStart },
      },
      select: {
        id: true,
        employeeId: true,
        type: true,
        status: true,
        dedupeKey: true,
        punchId: true,
        segmentId: true,
        secondSegmentId: true,
      },
    });

    const newSegments: Prisma.WorkSegmentCreateManyInput[] = [];
    const statusChanges: Array<{ id: string; status: SegmentStatus }> = [];
    const plans = people.map((employeeId) => {
      const own = <T extends { employeeId: string | null }>(rows: T[]) =>
        rows.filter((row) => row.employeeId === employeeId);
      const stored: StoredSegment[] = own(segments);
      const ownPunches: PairablePunch[] = own(punches);
      const pairing = pairPunches(ownPunches, now);
      const plan = planSegments(pairing, stored, windowStart);
      for (const segment of plan.create) {
        newSegments.push({
          companyId,
          employeeId,
          siteId: segment.siteId,
          workDate: fromIsoDate(toAccraDate(segment.startedAt)),
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          workedMinutes: Math.floor(
            (segment.endedAt.getTime() - segment.startedAt.getTime()) / 60_000,
          ),
          basis: segment.basis,
          status: segment.status,
          clockInPunchId: segment.clockInPunchId,
          clockOutPunchId: segment.clockOutPunchId,
        });
      }
      statusChanges.push(...plan.change);
      return { employeeId, ownPunches, pairing, plan, stored, exceptions: own(exceptions) };
    });

    // Segments first: the overlap exceptions below need the new rows' IDs.
    const created =
      newSegments.length === 0
        ? []
        : await tx.workSegment.createManyAndReturn({
            data: newSegments,
            select: { id: true, clockInPunchId: true, clockOutPunchId: true },
          });
    const idForRef = new Map(
      created.map((row) => [
        newSegmentRef(row.clockInPunchId ?? '', row.clockOutPunchId ?? ''),
        row.id,
      ]),
    );
    await this.applyStatusChanges(tx, statusChanges, now);

    const wantedExceptions = new Map<string, Prisma.AttendanceExceptionCreateManyInput>();
    const reopen: string[] = [];
    const autoClose: string[] = [];
    for (const {
      employeeId,
      ownPunches,
      pairing,
      plan,
      stored,
      exceptions: ownExceptions,
    } of plans) {
      const missing = (type: 'MISSING_CLOCK_OUT' | 'MISSING_CLOCK_IN', punch: PairablePunch) =>
        wantedExceptions.set(missingKey(type, punch.id), {
          companyId,
          type,
          dedupeKey: missingKey(type, punch.id),
          siteId: punch.siteId,
          employeeId,
          punchId: punch.id,
          occurredAt: punch.deviceTime,
          workDate: fromIsoDate(toAccraDate(punch.deviceTime)),
        });
      for (const punch of pairing.missingClockOut) missing('MISSING_CLOCK_OUT', punch);
      for (const punch of pairing.missingClockIn) missing('MISSING_CLOCK_IN', punch);

      for (const [first, second] of plan.overlaps) {
        const firstId = idForRef.get(first.ref) ?? first.ref;
        const secondId = idForRef.get(second.ref) ?? second.ref;
        wantedExceptions.set(overlapKey(firstId, secondId), {
          companyId,
          type: 'OVERLAP',
          dedupeKey: overlapKey(firstId, secondId),
          siteId: first.siteId,
          secondSiteId: second.siteId === first.siteId ? null : second.siteId,
          employeeId,
          segmentId: firstId,
          secondSegmentId: secondId,
          occurredAt: second.startedAt,
          workDate: fromIsoDate(toAccraDate(second.startedAt)),
        });
      }

      const checkedSegmentIds = new Set([
        ...stored.filter((segment) => segment.startedAt >= windowStart).map((row) => row.id),
        ...plan.create.map((segment) => idForRef.get(segment.ref) ?? ''),
      ]);
      const decided = planExceptions({
        wantedKeys: new Set(wantedExceptions.keys()),
        stored: ownExceptions as StoredException[],
        checkedPunchIds: new Set(ownPunches.map((punch) => punch.id)),
        checkedSegmentIds,
      });
      reopen.push(...decided.reopen);
      autoClose.push(...decided.autoClose);
    }

    if (wantedExceptions.size > 0) {
      // Already-raised ones (even RESOLVED ones) are skipped by the unique dedupe key.
      await tx.attendanceException.createMany({
        data: [...wantedExceptions.values()],
        skipDuplicates: true,
      });
    }
    if (reopen.length > 0) {
      await tx.attendanceException.updateMany({
        where: { id: { in: reopen }, status: 'AUTO_CLOSED' },
        data: { status: 'OPEN' },
      });
    }
    if (autoClose.length > 0) {
      await tx.attendanceException.updateMany({
        where: { id: { in: autoClose }, status: 'OPEN' },
        data: { status: 'AUTO_CLOSED' },
      });
    }
  }

  /**
   * A clock-in with no clock-out only becomes a problem once 16 hours pass,
   * and nothing else may happen for that person to notice it. Each signed
   * heartbeat therefore looks for such clock-ins, company-wide, and re-pairs
   * those people. Finding nobody (the usual case) costs one read and no lock.
   */
  async repairOverdueClockIns(companyId: string, now: Date): Promise<void> {
    const windowStart = new Date(now.getTime() - PAIRING_WINDOW_DAYS * DAY_MS);
    const overdueBefore = new Date(now.getTime() - MAX_SHIFT_MS);
    const overdue = await this.prisma.$queryRaw<Array<{ employee_id: string }>>`
      SELECT DISTINCT p.employee_id
      FROM punch_events p
      WHERE p.company_id = ${companyId}::uuid
        AND p.employee_id IS NOT NULL
        AND p.pairable
        AND p.direction = 'IN'
        AND p.device_time >= ${windowStart}
        AND p.device_time < ${overdueBefore}
        AND NOT EXISTS (SELECT 1 FROM work_segments s WHERE s.clock_in_punch_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM attendance_exceptions e
          WHERE e.punch_id = p.id AND e.type = 'MISSING_CLOCK_OUT')
        -- A repeat tap (an earlier IN within 2 minutes at the same site) is never paired.
        AND NOT EXISTS (
          SELECT 1 FROM punch_events r
          WHERE r.employee_id = p.employee_id AND r.site_id = p.site_id AND r.pairable
            AND r.direction IN ('IN', 'UNKNOWN')
            AND (r.device_time, r.id) < (p.device_time, p.id)
            AND r.device_time > p.device_time - interval '2 minutes')
      LIMIT ${OVERDUE_PEOPLE_PER_HEARTBEAT}`;
    if (overdue.length === 0) {
      return;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockCompanyAttendance(tx, companyId);
        await this.repair(
          tx,
          companyId,
          overdue.map((row) => row.employee_id),
          now,
        );
      }, ATTENDANCE_TRANSACTION_OPTIONS);
    } catch (error) {
      throw isLockTimeout(error) ? new AttendanceBusyException() : error;
    }
  }

  private async applyStatusChanges(
    tx: Prisma.TransactionClient,
    changes: ReadonlyArray<{ id: string; status: SegmentStatus }>,
    now: Date,
  ): Promise<void> {
    for (const status of ['VOIDED', 'CONFIRMED', 'DISPUTED'] as const) {
      const ids = changes.filter((change) => change.status === status).map((change) => change.id);
      if (ids.length > 0) {
        // A void by re-pairing leaves `voided_by_user_id` empty, so it can come back later.
        await tx.workSegment.updateMany({
          where: { id: { in: ids } },
          data: { status, voidedAt: status === 'VOIDED' ? now : null },
        });
      }
    }
  }
}
