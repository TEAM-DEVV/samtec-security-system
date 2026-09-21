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
    // From 16 hours before the window, so a shift that straddles its edge is
    // seen whole (and then left alone) instead of leaving a lone clock-out.
    const punches = (
      await tx.punchEvent.findMany({
        where: {
          companyId,
          employeeId: { in: people },
          pairable: true,
          deviceTime: { gte: new Date(windowStart.getTime() - MAX_SHIFT_MS) },
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

    // Each person's rows, grouped once.
    const segmentsOf = groupByEmployee(segments);
    const punchesOf = groupByEmployee(punches);
    const exceptionsOf = groupByEmployee(exceptions);
    const inWindow = (punch: PairablePunch) => punch.deviceTime >= windowStart;

    const newSegments: Prisma.WorkSegmentCreateManyInput[] = [];
    const statusChanges: Array<{ id: string; status: SegmentStatus }> = [];
    const plans = people.map((employeeId) => {
      const stored: StoredSegment[] = segmentsOf.get(employeeId) ?? [];
      const ownPunches: PairablePunch[] = punchesOf.get(employeeId) ?? [];
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
      return { employeeId, ownPunches, pairing, plan, stored };
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
    await this.applyStatusChanges(tx, companyId, statusChanges, now);

    const wantedExceptions = new Map<string, Prisma.AttendanceExceptionCreateManyInput>();
    const reopen: string[] = [];
    const autoClose: string[] = [];
    for (const { employeeId, ownPunches, pairing, plan, stored } of plans) {
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
      // Only inside the window: older punches belong to the past.
      for (const punch of pairing.missingClockOut.filter(inWindow)) {
        missing('MISSING_CLOCK_OUT', punch);
      }
      for (const punch of pairing.missingClockIn.filter(inWindow)) {
        missing('MISSING_CLOCK_IN', punch);
      }

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
      const stillOpen: StoredException[] = exceptionsOf.get(employeeId) ?? [];
      const decided = planExceptions({
        wantedKeys: new Set(wantedExceptions.keys()),
        stored: stillOpen,
        checkedPunchIds: new Set(ownPunches.filter(inWindow).map((punch) => punch.id)),
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
        where: { companyId, id: { in: reopen }, status: 'AUTO_CLOSED' },
        data: { status: 'OPEN' },
      });
    }
    if (autoClose.length > 0) {
      await tx.attendanceException.updateMany({
        where: { companyId, id: { in: autoClose }, status: 'OPEN' },
        data: { status: 'AUTO_CLOSED' },
      });
    }
  }

  /**
   * A clock-in with no clock-out only becomes a problem once 16 hours pass,
   * and nothing else may happen for that person to notice it. So every signed
   * heartbeat re-pairs the people whose punches turned 16 hours old since the
   * last check, and moves the company's bookmark (`attendance_checks`)
   * forward. Pairing then decides what is missing: the rules exist only once,
   * in `pairing.ts`. When no punch turned 16 hours old (the usual case), the
   * check costs two small reads and one small write, and takes no lock.
   */
  async repairOverdueClockIns(companyId: string, now: Date): Promise<void> {
    const slice = await this.nextOverdueSlice(this.prisma, companyId, now);
    if (!slice) {
      return;
    }
    const waiting = await this.prisma.punchEvent.findFirst({
      where: overdueSliceFilter(companyId, slice),
      select: { id: true },
    });
    if (!waiting) {
      await this.moveBookmark(this.prisma, companyId, slice);
      return;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockCompanyAttendance(tx, companyId);
        // Read again under the lock: another heartbeat may have just done it.
        const locked = await this.nextOverdueSlice(tx, companyId, now);
        if (!locked) {
          return;
        }
        const punched = await tx.punchEvent.findMany({
          where: overdueSliceFilter(companyId, locked),
          select: { employeeId: true },
          distinct: ['employeeId'],
        });
        await this.repair(
          tx,
          companyId,
          punched.flatMap((row) => (row.employeeId ? [row.employeeId] : [])),
          now,
        );
        await this.moveBookmark(tx, companyId, locked);
      }, ATTENDANCE_TRANSACTION_OPTIONS);
    } catch (error) {
      throw isLockTimeout(error) ? new AttendanceBusyException() : error;
    }
  }

  /**
   * The punch times to check now: from the bookmark to 16 hours ago, at most
   * 16 hours of them per heartbeat (after an outage it catches up quickly,
   * without one huge transaction). A company's first check starts 32 hours
   * ago; everything older was already paired when it arrived.
   */
  private async nextOverdueSlice(
    db: Prisma.TransactionClient,
    companyId: string,
    now: Date,
  ): Promise<OverdueSlice | null> {
    const until = now.getTime() - MAX_SHIFT_MS;
    const bookmark = await db.attendanceCheck.findUnique({ where: { companyId } });
    const from = bookmark?.overdueCheckedUntil ?? new Date(until - MAX_SHIFT_MS);
    const to = new Date(Math.min(until, from.getTime() + MAX_SHIFT_MS));
    return to > from ? { from, to, bookmarked: bookmark !== null } : null;
  }

  /** Moves the bookmark forward only: a concurrent heartbeat that got there first wins. */
  private async moveBookmark(
    db: Prisma.TransactionClient,
    companyId: string,
    slice: OverdueSlice,
  ): Promise<void> {
    if (slice.bookmarked) {
      await db.attendanceCheck.updateMany({
        where: { companyId, overdueCheckedUntil: slice.from },
        data: { overdueCheckedUntil: slice.to },
      });
    } else {
      await db.attendanceCheck.createMany({
        data: [{ companyId, overdueCheckedUntil: slice.to }],
        skipDuplicates: true,
      });
    }
  }

  private async applyStatusChanges(
    tx: Prisma.TransactionClient,
    companyId: string,
    changes: ReadonlyArray<{ id: string; status: SegmentStatus }>,
    now: Date,
  ): Promise<void> {
    for (const status of ['VOIDED', 'CONFIRMED', 'DISPUTED'] as const) {
      const ids = changes.filter((change) => change.status === status).map((change) => change.id);
      if (ids.length > 0) {
        // A void by re-pairing leaves `voided_by_user_id` empty, so it can come back later.
        await tx.workSegment.updateMany({
          where: { companyId, id: { in: ids } },
          data: { status, voidedAt: status === 'VOIDED' ? now : null },
        });
      }
    }
  }
}

interface OverdueSlice {
  from: Date;
  to: Date;
  /** Whether the company already has a bookmark row. */
  bookmarked: boolean;
}

function overdueSliceFilter(companyId: string, slice: OverdueSlice): Prisma.PunchEventWhereInput {
  return {
    companyId,
    pairable: true,
    employeeId: { not: null },
    deviceTime: { gte: slice.from, lt: slice.to },
  };
}

function groupByEmployee<Row extends { employeeId: string | null }>(
  rows: Row[],
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.employeeId !== null) {
      groups.set(row.employeeId, [...(groups.get(row.employeeId) ?? []), row]);
    }
  }
  return groups;
}
