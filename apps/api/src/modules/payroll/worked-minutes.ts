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
 * How long a shift pattern is.
 *
 * It lives in `src/common/shift-length.ts`, because the workforce module
 * needs the same answer when it reports what each date was scheduled for,
 * and neither module may import the other. It is re-exported here so this
 * file still reads as the one place payroll's minutes are worked out.
 */
export { shiftLengthMinutes } from '../../common/shift-length.js';

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
  const startDate = calendarDate(period.startDate, 'The period start');
  const endDate = calendarDate(period.endDate, 'The period end');
  const byDate = new Map<string, number>();
  for (const segment of segments) {
    if (segment.status !== 'CONFIRMED') continue;
    const workDate = calendarDate(segment.workDate, 'A segment work date');
    if (workDate < startDate || workDate > endDate) continue;
    byDate.set(workDate, (byDate.get(workDate) ?? 0) + segment.workedMinutes);
  }
  return (
    [...byDate.entries()]
      // Plain text order, the same comparison the filter above uses. A calendar
      // date in this format sorts correctly as text, and localeCompare would be
      // a second, slower ordering over one set of data.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([workDate, workedMinutes]) => ({
        workDate,
        workedMinutes,
        scheduledMinutes: scheduledMinutesOn(workDate),
      }))
  );
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
  const startDate = calendarDate(period.startDate, 'The period start');
  const endDate = calendarDate(period.endDate, 'The period end');
  const days = new Set<string>();
  for (const spell of employment) {
    const startsOn = calendarDate(spell.startsOn, 'An employment start date');
    const endsOn =
      spell.endsOn === null ? null : calendarDate(spell.endsOn, 'An employment end date');
    const from = startsOn > startDate ? startsOn : startDate;
    const to = endsOn !== null && endsOn < endDate ? endsOn : endDate;
    for (const day of datesBetween(from, to)) days.add(day);
  }
  return days.size;
}

/**
 * Refuses anything but a plain calendar date.
 *
 * Every date in this file is compared as text, and a `@db.Date` column reaches
 * the contract through `toIsoDate`. A missed conversion hands over a full
 * timestamp instead, which TypeScript cannot tell apart — both are `string`.
 * It would not throw: `'2026-09-01' < '2026-09-01T00:00:00.000Z'` is true, so
 * the first day of the month would silently drop out of somebody's minutes,
 * and `Date.parse` of a doubled timestamp gives `NaN`, so their days employed
 * would come out zero and they would be paid nothing. A loud failure here is
 * the difference between a test going red and a worker being under-paid.
 */
function calendarDate(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${what} must be a plain calendar date such as 2026-09-01, not "${value}".`);
  }
  return value;
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
  return datesBetween(
    calendarDate(period.startDate, 'The period start'),
    calendarDate(period.endDate, 'The period end'),
  ).length;
}
