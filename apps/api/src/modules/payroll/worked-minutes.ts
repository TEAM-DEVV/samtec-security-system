import type { SegmentStatus } from '@samtec/contracts';

/**
 * Which minutes of a payroll period are paid, and which of them are overtime.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, decisions 3, 5 and 6. Pure
 * functions only — no database, no `this` — so every rule below can be proved
 * on its own.
 */

/** A worker with no assigned shift pattern is assumed to work an eight-hour day. */
export const DEFAULT_SCHEDULED_MINUTES = 480;

/**
 * How long a shift pattern runs, in minutes. A night shift wraps past
 * midnight — 22:00 to 06:00 is 1320 to 360 — so the day is added back before
 * the remainder is taken.
 */
export function shiftLengthMinutes(startMinutes: number, endMinutes: number): number {
  return (endMinutes - startMinutes + 1440) % 1440;
}

/** One confirmed shift, as the attendance module recorded it. */
export interface PayableSegment {
  /**
   * The Ghana calendar date the hours belong to, as `YYYY-MM-DD`. The
   * attendance module has already decided this: a night shift counts on the
   * day it started, so one that begins on 30 September and ends on 1 October
   * belongs to September (decision 5).
   */
  workDate: string;
  workedMinutes: number;
  status: SegmentStatus;
}

/** One work date of the period, with what was scheduled and what was worked. */
export interface WorkedDay {
  workDate: string;
  scheduledMinutes: number;
  workedMinutes: number;
}

export interface PeriodMinutes {
  /** What the shift patterns scheduled on the days actually worked. */
  scheduledMinutes: number;
  /** Everything confirmed: `regularMinutes` plus `overtimeMinutes`. */
  punchedMinutes: number;
  /** The part inside each day's scheduled length; the basic pay covers these. */
  regularMinutes: number;
  /** The part beyond it, paid at the overtime rate. */
  overtimeMinutes: number;
}

/**
 * The confirmed work of one employee inside one period, one row per work date.
 *
 * Only `CONFIRMED` segments are paid: a disputed shift is still being argued
 * about and a voided one did not happen (decision 6). A segment belongs to the
 * period its `workDate` falls in, whatever time it ended (decision 5).
 */
export function workedDaysIn(
  segments: readonly PayableSegment[],
  period: { startDate: string; endDate: string },
  scheduledMinutesOn: (workDate: string) => number,
): WorkedDay[] {
  const byDate = new Map<string, number>();
  for (const segment of segments) {
    if (segment.status !== 'CONFIRMED') continue;
    if (segment.workDate < period.startDate || segment.workDate > period.endDate) continue;
    byDate.set(segment.workDate, (byDate.get(segment.workDate) ?? 0) + segment.workedMinutes);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([workDate, workedMinutes]) => ({
      workDate,
      workedMinutes,
      scheduledMinutes: scheduledMinutesOn(workDate),
    }));
}

/**
 * Splits the period's confirmed minutes into regular and overtime, one day at
 * a time: anything worked beyond what that date's shift pattern scheduled is
 * overtime (decision 3). Working less than the schedule never creates negative
 * overtime, and never reduces the basic pay — absence is handled by the
 * attendance exception queue, not by docking pay (decision 4).
 */
export function minutesForPeriod(days: readonly WorkedDay[]): PeriodMinutes {
  let scheduledMinutes = 0;
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  for (const day of days) {
    scheduledMinutes += day.scheduledMinutes;
    const overtime = Math.max(0, day.workedMinutes - day.scheduledMinutes);
    overtimeMinutes += overtime;
    regularMinutes += day.workedMinutes - overtime;
  }
  return {
    scheduledMinutes,
    punchedMinutes: regularMinutes + overtimeMinutes,
    regularMinutes,
    overtimeMinutes,
  };
}

/**
 * Whole days of the period the worker was employed, counting both end days.
 * It is the overlap of their employment with the period, so a worker who
 * joined or left inside the month is paid for the days they were on the books
 * (decision 4). A re-hired worker's gap is excluded, because each employment
 * period is counted separately.
 */
export function daysEmployedIn(
  employment: readonly { startsOn: string; endsOn: string | null }[],
  period: { startDate: string; endDate: string },
): number {
  const days = new Set<string>();
  for (const spell of employment) {
    const from = spell.startsOn > period.startDate ? spell.startsOn : period.startDate;
    const to =
      spell.endsOn !== null && spell.endsOn < period.endDate ? spell.endsOn : period.endDate;
    for (const day of datesBetween(from, to)) days.add(day);
  }
  return days.size;
}

/** Every calendar date from `from` to `to`, both included. Empty when `to` is earlier. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const last = Date.parse(`${to}T00:00:00Z`);
  let at = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(at) || Number.isNaN(last)) return dates;
  while (at <= last) {
    dates.push(new Date(at).toISOString().slice(0, 10));
    at += 86_400_000;
  }
  return dates;
}

/** Calendar days in the period, counting both end days. */
export function daysInPeriod(period: { startDate: string; endDate: string }): number {
  return datesBetween(period.startDate, period.endDate).length;
}
