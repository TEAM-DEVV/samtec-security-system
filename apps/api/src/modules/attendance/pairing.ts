/**
 * Pairing: turning one person's punches into worked shifts, and deciding what
 * must change in the stored segments and the exception queue. Everything here
 * is a pure function: no database, no clock except the `now` passed in, so
 * the tests can check every rule directly. docs/plan/12 §4 and §5.
 */

/** A shift lasts at most this long; an IN older than this with no OUT is missing one. */
export const MAX_SHIFT_MS = 16 * 3_600_000;
/** A second tap within this time that counts the same way (IN or OUT) is the same act. */
export const REPEAT_TAP_MS = 2 * 60_000;
/** Re-pairing always recomputes this many days back. Older segments are never changed. */
export const PAIRING_WINDOW_DAYS = 62;

export type Direction = 'IN' | 'OUT' | 'UNKNOWN';
export type SegmentStatus = 'CONFIRMED' | 'DISPUTED' | 'VOIDED';
export type SegmentBasis = 'BIOMETRIC' | 'PIN_FALLBACK' | 'MANUAL';

export interface PairablePunch {
  id: string;
  siteId: string;
  deviceTime: Date;
  direction: Direction;
  method: 'FINGERPRINT' | 'FACE' | 'PIN_FALLBACK';
}

export interface Shift {
  clockIn: PairablePunch;
  clockOut: PairablePunch;
}

export interface Pairing {
  shifts: Shift[];
  /** INs that will never get an OUT: a later punch moved on, or 16 hours passed. */
  missingClockOut: PairablePunch[];
  /** OUTs with no IN in the 16 hours before them. */
  missingClockIn: PairablePunch[];
}

/** At the same second: OUT first, then UNKNOWN, then IN, so a handover makes touching shifts. */
const TIE_ORDER: Record<Direction, number> = { OUT: 0, UNKNOWN: 1, IN: 2 };

function comparePunches(a: PairablePunch, b: PairablePunch): number {
  return (
    a.deviceTime.getTime() - b.deviceTime.getTime() ||
    TIE_ORDER[a.direction] - TIE_ORDER[b.direction] ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The one pairing rule: an IN followed by an OUT of the same person, at the
 * same site, no more than 16 hours later. Each site is paired on its own, so
 * one person on shift at two sites at once makes two shifts (an overlap a
 * person must look at), never a silently merged one. Only moments in time are
 * compared: dates, clock times and shift patterns never matter, so a night
 * shift across midnight is just an IN followed by an OUT.
 */
export function pairPunches(punches: readonly PairablePunch[], now: Date): Pairing {
  const pairing: Pairing = { shifts: [], missingClockOut: [], missingClockIn: [] };
  const bySite = new Map<string, PairablePunch[]>();
  for (const punch of punches) {
    bySite.set(punch.siteId, [...(bySite.get(punch.siteId) ?? []), punch]);
  }

  // Sites in a fixed order, so the result never depends on arrival order.
  for (const siteId of [...bySite.keys()].sort()) {
    const sitePunches = bySite.get(siteId) ?? [];
    let open: PairablePunch | null = null;
    // The previous punch here, and what it counted as (IN or OUT).
    let previous: { at: number; counted: 'IN' | 'OUT' } | null = null;
    for (const punch of [...sitePunches].sort(comparePunches)) {
      const at = punch.deviceTime.getTime();
      // A repeat tap: less than 2 minutes after the previous punch, and either
      // UNKNOWN or the same as what that punch counted as. A chain of quick
      // taps is one act, so the chain carries the first tap's meaning.
      if (
        previous !== null &&
        at - previous.at < REPEAT_TAP_MS &&
        (punch.direction === 'UNKNOWN' || punch.direction === previous.counted)
      ) {
        previous = { at, counted: previous.counted };
        continue;
      }
      const openIsFresh = open !== null && at - open.deviceTime.getTime() <= MAX_SHIFT_MS;
      const direction =
        punch.direction === 'UNKNOWN' ? (openIsFresh ? 'OUT' : 'IN') : punch.direction;
      previous = { at, counted: direction };

      if (direction === 'IN') {
        if (open) pairing.missingClockOut.push(open);
        open = punch;
      } else if (open && openIsFresh) {
        pairing.shifts.push({ clockIn: open, clockOut: punch });
        open = null;
      } else {
        if (open) pairing.missingClockOut.push(open);
        pairing.missingClockIn.push(punch);
        open = null;
      }
    }
    // An IN still open may simply be a shift in progress, until 16 hours pass.
    if (open && now.getTime() - open.deviceTime.getTime() > MAX_SHIFT_MS) {
      pairing.missingClockOut.push(open);
    }
  }
  return pairing;
}

/** The stored segments of one person that re-pairing looks at (those ending inside the window). */
export interface StoredSegment {
  id: string;
  siteId: string;
  startedAt: Date;
  endedAt: Date;
  basis: SegmentBasis;
  status: SegmentStatus;
  clockInPunchId: string | null;
  clockOutPunchId: string | null;
  /** Set when a person voided it: then it is never brought back. */
  voidedByUserId: string | null;
}

/** A segment as re-pairing wants it: `ref` is its row ID, or `new:<in>:<out>` for one to create. */
export interface WantedSegment {
  ref: string;
  siteId: string;
  startedAt: Date;
  endedAt: Date;
  status: 'CONFIRMED' | 'DISPUTED';
  /** Older than the window: it takes part in overlap checks but is never changed. */
  frozen: boolean;
}

export interface NewSegment {
  ref: string;
  siteId: string;
  clockInPunchId: string;
  clockOutPunchId: string;
  startedAt: Date;
  endedAt: Date;
  basis: 'BIOMETRIC' | 'PIN_FALLBACK';
  status: 'CONFIRMED' | 'DISPUTED';
}

export interface SegmentChange {
  id: string;
  status: SegmentStatus;
}

export interface SegmentPlan {
  create: NewSegment[];
  /** Existing rows whose status must change (including voids and reactivations). */
  change: SegmentChange[];
  /** Every segment that counts or waits for a person after the plan is applied. */
  live: WantedSegment[];
  /** Pairs of live segments that overlap each other, as refs, earlier start first. */
  overlaps: Array<[WantedSegment, WantedSegment]>;
}

export const newSegmentRef = (clockInPunchId: string, clockOutPunchId: string) =>
  `new:${clockInPunchId}:${clockOutPunchId}`;

/**
 * Brings one person's stored segments in line with a fresh pairing:
 * - a shift that has no row yet gets one;
 * - a row that re-pairing voided earlier comes back if its shift is wanted again;
 * - a row a *person* voided stays voided, even if its shift is wanted;
 * - a derived row whose shift is no longer wanted is voided (never deleted);
 * - hand-added (MANUAL) rows are never voided here;
 * - rows that started before the window (`frozen`) are never changed, and a
 *   shift that began before it is never created.
 * Then every live segment that overlaps another is DISPUTED, the rest CONFIRMED.
 */
export function planSegments(
  pairing: Pairing,
  stored: readonly StoredSegment[],
  windowStart: Date,
): SegmentPlan {
  const isFrozen = (segment: StoredSegment) => segment.startedAt < windowStart;
  const byPunches = new Map(
    stored
      .filter((segment) => segment.basis !== 'MANUAL' && !isFrozen(segment))
      .map((segment) => [`${segment.clockInPunchId}:${segment.clockOutPunchId}`, segment]),
  );

  const candidates: Array<{ wanted: WantedSegment; row?: StoredSegment; shift?: Shift }> = [];
  const wantedRowIds = new Set<string>();
  for (const shift of pairing.shifts) {
    if (shift.clockIn.deviceTime < windowStart) {
      continue; // A shift that began before the window belongs to the past, which never changes.
    }
    const row = byPunches.get(`${shift.clockIn.id}:${shift.clockOut.id}`);
    if (row) {
      wantedRowIds.add(row.id);
      if (row.voidedByUserId !== null) {
        continue; // A person decided this shift does not count.
      }
    }
    candidates.push({
      row,
      shift,
      wanted: {
        ref: row?.id ?? newSegmentRef(shift.clockIn.id, shift.clockOut.id),
        siteId: shift.clockIn.siteId,
        startedAt: shift.clockIn.deviceTime,
        endedAt: shift.clockOut.deviceTime,
        status: 'CONFIRMED',
        frozen: false,
      },
    });
  }
  for (const segment of stored) {
    const keepsItsRow = segment.basis === 'MANUAL' || isFrozen(segment);
    if (keepsItsRow && segment.status !== 'VOIDED') {
      candidates.push({
        row: segment,
        wanted: {
          ref: segment.id,
          siteId: segment.siteId,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          status: segment.status === 'DISPUTED' ? 'DISPUTED' : 'CONFIRMED',
          frozen: isFrozen(segment),
        },
      });
    }
  }

  // Overlaps: ranges include their start and exclude their end, so touching shifts are fine.
  // Sorted by start, the inner loop stops at the first shift that starts
  // after this one ends, so this stays fast for a person's 62 days.
  const live = candidates
    .map((candidate) => candidate.wanted)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.ref.localeCompare(b.ref));
  const overlaps: Array<[WantedSegment, WantedSegment]> = [];
  const disputed = new Set<string>();
  live.forEach((first, index) => {
    for (const second of live.slice(index + 1)) {
      if (second.startedAt >= first.endedAt) break;
      if (first.frozen && second.frozen) continue; // Both older than the window: left alone.
      overlaps.push([first, second]);
      disputed.add(first.ref);
      disputed.add(second.ref);
    }
  });
  for (const wanted of live) {
    if (!wanted.frozen) {
      wanted.status = disputed.has(wanted.ref) ? 'DISPUTED' : 'CONFIRMED';
    }
  }

  const plan: SegmentPlan = { create: [], change: [], live, overlaps };
  for (const { row, shift, wanted } of candidates) {
    if (wanted.frozen) continue;
    if (!row && shift) {
      plan.create.push({
        ref: wanted.ref,
        siteId: wanted.siteId,
        clockInPunchId: shift.clockIn.id,
        clockOutPunchId: shift.clockOut.id,
        startedAt: wanted.startedAt,
        endedAt: wanted.endedAt,
        basis:
          shift.clockIn.method === 'PIN_FALLBACK' || shift.clockOut.method === 'PIN_FALLBACK'
            ? 'PIN_FALLBACK'
            : 'BIOMETRIC',
        status: wanted.status,
      });
    } else if (row && row.status !== wanted.status) {
      plan.change.push({ id: row.id, status: wanted.status });
    }
  }
  for (const row of byPunches.values()) {
    if (!wantedRowIds.has(row.id) && row.status !== 'VOIDED') {
      plan.change.push({ id: row.id, status: 'VOIDED' });
    }
  }
  return plan;
}

/** An exception that re-pairing may close or reopen (it only ever loads OPEN and AUTO_CLOSED ones). */
export interface StoredException {
  id: string;
  type: string;
  status: string;
  dedupeKey: string;
  punchId: string | null;
  segmentId: string | null;
  secondSegmentId: string | null;
}

export const missingKey = (type: 'MISSING_CLOCK_OUT' | 'MISSING_CLOCK_IN', punchId: string) =>
  `${type}:${punchId}`;

export const overlapKey = (firstSegmentId: string, secondSegmentId: string) =>
  `OVERLAP:${[firstSegmentId, secondSegmentId].sort().join(':')}`;

export interface ExceptionPlan {
  /** Dedupe keys that must be open now; ones already RESOLVED stay resolved. */
  wantedKeys: Set<string>;
  reopen: string[];
  autoClose: string[];
}

/**
 * Which exceptions this re-pairing opens, closes or reopens. An exception is
 * only ever closed automatically when its evidence was part of this
 * re-pairing (`checkedPunchIds`, `checkedSegmentIds`) and the problem is gone,
 * for example when a late clock-out finally arrives. A RESOLVED one is never
 * touched: a person already decided.
 */
export function planExceptions(input: {
  wantedKeys: Set<string>;
  stored: readonly StoredException[];
  checkedPunchIds: ReadonlySet<string>;
  checkedSegmentIds: ReadonlySet<string>;
}): ExceptionPlan {
  const plan: ExceptionPlan = { wantedKeys: input.wantedKeys, reopen: [], autoClose: [] };
  for (const exception of input.stored) {
    const checked =
      exception.type === 'OVERLAP'
        ? [exception.segmentId, exception.secondSegmentId].some(
            (id) => id !== null && input.checkedSegmentIds.has(id),
          )
        : exception.punchId !== null && input.checkedPunchIds.has(exception.punchId);
    const wanted = input.wantedKeys.has(exception.dedupeKey);
    if (wanted && exception.status === 'AUTO_CLOSED') {
      plan.reopen.push(exception.id);
    } else if (!wanted && checked && exception.status === 'OPEN') {
      plan.autoClose.push(exception.id);
    }
  }
  return plan;
}
