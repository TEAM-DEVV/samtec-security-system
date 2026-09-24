import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULED_MINUTES,
  daysEmployedIn,
  daysInPeriod,
  minutesForPeriod,
  type PayableSegment,
  shiftLengthMinutes,
  workedDaysIn,
} from './worked-minutes.js';

const SEPTEMBER = { startDate: '2026-09-01', endDate: '2026-09-30' };

/** A night shift, 22:00 to 06:00, as a shift pattern stores it. */
const NIGHT = { startMinutes: 1320, endMinutes: 360 };
/** A twelve-hour day shift, 06:00 to 18:00. */
const DAY = { startMinutes: 360, endMinutes: 1080 };

function segment(
  workDate: string,
  workedMinutes: number,
  status: PayableSegment['status'] = 'CONFIRMED',
) {
  return { workDate, workedMinutes, status };
}

describe('shiftLengthMinutes', () => {
  it('measures a day shift straight through', () => {
    expect(shiftLengthMinutes(DAY.startMinutes, DAY.endMinutes)).toBe(720);
    expect(shiftLengthMinutes(360, 840)).toBe(480);
  });

  it('measures a night shift that wraps past midnight', () => {
    // 22:00 to 06:00 is eight hours, not minus sixteen.
    expect(shiftLengthMinutes(NIGHT.startMinutes, NIGHT.endMinutes)).toBe(480);
    expect(shiftLengthMinutes(1080, 360)).toBe(720);
  });

  it('assumes eight hours where no pattern is assigned', () => {
    expect(DEFAULT_SCHEDULED_MINUTES).toBe(480);
  });
});

/**
 * Golden case 6 from docs/plan/09-payroll-engine-ghana.md: a night shift that
 * crosses the period boundary. Decision 5 settles it — a shift belongs to the
 * period its work date falls in, which the attendance module has already
 * decided, so a 22:00 shift starting on 30 September is paid in September
 * even though it ends in October.
 */
describe('which shifts belong to the period', () => {
  const nightShifts: PayableSegment[] = [
    // The whole of the first three weeks.
    ...Array.from({ length: 21 }, (_, index) =>
      segment(`2026-09-${String(index + 1).padStart(2, '0')}`, 480),
    ),
    // Started 30 September at 22:00, ended 1 October at 06:00.
    segment('2026-09-30', 480),
    // Started 31 August at 22:00, ended 1 September at 06:00.
    segment('2026-08-31', 480),
    // Still being argued about, and one that did not happen.
    segment('2026-09-22', 480, 'DISPUTED'),
    segment('2026-09-23', 480, 'VOIDED'),
  ];

  const days = workedDaysIn(nightShifts, SEPTEMBER, () => 480);

  it('pays the night shift that starts on the last day of the month', () => {
    expect(days.some((day) => day.workDate === '2026-09-30')).toBe(true);
  });

  it('does not pay the one that started in the month before', () => {
    // It belongs to August, whatever time it ended.
    expect(days.some((day) => day.workDate === '2026-08-31')).toBe(false);
  });

  it('skips a disputed shift and a voided one', () => {
    expect(days.some((day) => day.workDate === '2026-09-22')).toBe(false);
    expect(days.some((day) => day.workDate === '2026-09-23')).toBe(false);
  });

  it('counts exactly the twenty-two nights that were confirmed inside the month', () => {
    const minutes = minutesForPeriod(days);
    expect(days).toHaveLength(22);
    expect(minutes.punchedMinutes).toBe(22 * 480);
    expect(minutes.regularMinutes).toBe(22 * 480);
    expect(minutes.overtimeMinutes).toBe(0);
    expect(minutes.scheduledMinutes).toBe(22 * 480);
  });

  it('adds up two shifts that share one work date', () => {
    const twice = workedDaysIn(
      [segment('2026-09-05', 300), segment('2026-09-05', 180)],
      SEPTEMBER,
      () => 480,
    );
    expect(twice).toHaveLength(1);
    expect(twice[0]?.workedMinutes).toBe(480);
  });
});

describe('splitting a period into regular minutes and overtime', () => {
  it('counts anything beyond the day s scheduled length as overtime', () => {
    const days = workedDaysIn(
      [segment('2026-09-01', 600), segment('2026-09-02', 480), segment('2026-09-03', 540)],
      SEPTEMBER,
      () => 480,
    );
    const minutes = minutesForPeriod(days);
    expect(minutes.overtimeMinutes).toBe(120 + 0 + 60);
    expect(minutes.regularMinutes).toBe(480 * 3);
    expect(minutes.punchedMinutes).toBe(minutes.regularMinutes + minutes.overtimeMinutes);
  });

  it('never makes overtime negative when somebody worked less than the schedule', () => {
    const days = workedDaysIn([segment('2026-09-01', 300)], SEPTEMBER, () => 480);
    const minutes = minutesForPeriod(days);
    expect(minutes.overtimeMinutes).toBe(0);
    expect(minutes.regularMinutes).toBe(300);
    // Working short shows up here, and never reduces the basic pay.
    expect(minutes.scheduledMinutes).toBe(480);
  });

  it('uses each date s own shift pattern', () => {
    const scheduledOn = (workDate: string) =>
      workDate === '2026-09-01'
        ? shiftLengthMinutes(NIGHT.startMinutes, NIGHT.endMinutes)
        : shiftLengthMinutes(DAY.startMinutes, DAY.endMinutes);
    const days = workedDaysIn(
      [segment('2026-09-01', 600), segment('2026-09-02', 600)],
      SEPTEMBER,
      scheduledOn,
    );
    const minutes = minutesForPeriod(days);
    // 600 against a 480-minute night is two hours over; against a 720-minute
    // day it is two hours short.
    expect(minutes.overtimeMinutes).toBe(120);
    expect(minutes.scheduledMinutes).toBe(480 + 720);
  });

  it('reports nothing for a period with no confirmed shifts', () => {
    expect(minutesForPeriod([])).toEqual({
      scheduledMinutes: 0,
      punchedMinutes: 0,
      regularMinutes: 0,
      overtimeMinutes: 0,
    });
  });
});

describe('how many days of the period a worker was employed', () => {
  it('counts a whole month when they were there throughout', () => {
    expect(daysEmployedIn([{ startsOn: '2024-01-15', endsOn: null }], SEPTEMBER)).toBe(30);
    expect(daysInPeriod(SEPTEMBER)).toBe(30);
  });

  it('counts the day they joined and the day they left', () => {
    expect(daysEmployedIn([{ startsOn: '2026-09-16', endsOn: null }], SEPTEMBER)).toBe(15);
    expect(daysEmployedIn([{ startsOn: '2023-05-02', endsOn: '2026-09-10' }], SEPTEMBER)).toBe(10);
    expect(daysEmployedIn([{ startsOn: '2026-09-30', endsOn: '2026-09-30' }], SEPTEMBER)).toBe(1);
  });

  it('counts nothing for somebody employed outside the period', () => {
    expect(daysEmployedIn([{ startsOn: '2026-10-01', endsOn: null }], SEPTEMBER)).toBe(0);
    expect(daysEmployedIn([{ startsOn: '2023-01-01', endsOn: '2026-07-31' }], SEPTEMBER)).toBe(0);
    expect(daysEmployedIn([], SEPTEMBER)).toBe(0);
  });

  it('leaves out the gap when somebody left and was hired again', () => {
    // Away from the 11th to the 19th, so twenty-one of the thirty days are
    // paid: the 1st to the 10th, then the 20th to the 30th.
    const rehired = [
      { startsOn: '2024-01-01', endsOn: '2026-09-10' },
      { startsOn: '2026-09-20', endsOn: null },
    ];
    expect(daysEmployedIn(rehired, SEPTEMBER)).toBe(10 + 11);
  });

  it('counts a day once when two employment spells overlap', () => {
    const overlapping = [
      { startsOn: '2026-09-01', endsOn: '2026-09-20' },
      { startsOn: '2026-09-15', endsOn: '2026-09-25' },
    ];
    expect(daysEmployedIn(overlapping, SEPTEMBER)).toBe(25);
  });

  it('counts February correctly, leap year and not', () => {
    expect(daysInPeriod({ startDate: '2026-02-01', endDate: '2026-02-28' })).toBe(28);
    expect(daysInPeriod({ startDate: '2028-02-01', endDate: '2028-02-29' })).toBe(29);
  });
});

/**
 * Every date in this module is compared as text, so a full timestamp would not
 * fail loudly — it would sort wrongly and quietly under-pay somebody. These
 * tests pin the guard that turns that into an error.
 */
describe('dates that are not plain calendar dates', () => {
  it('refuses a timestamp where a period date belongs', () => {
    expect(() =>
      daysInPeriod({ startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30' }),
    ).toThrow(/plain calendar date/);
  });

  it('refuses a timestamp on an employment spell', () => {
    expect(() =>
      daysEmployedIn([{ startsOn: '2026-09-01T00:00:00.000Z', endsOn: null }], SEPTEMBER),
    ).toThrow(/plain calendar date/);
  });

  it('refuses a timestamp on a segment work date', () => {
    expect(() =>
      workedDaysIn(
        [{ workDate: '2026-09-01T00:00:00.000Z', workedMinutes: 480, status: 'CONFIRMED' }],
        SEPTEMBER,
        () => 480,
      ),
    ).toThrow(/plain calendar date/);
  });
});
