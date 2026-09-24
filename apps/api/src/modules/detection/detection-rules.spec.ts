import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  bilocation,
  conflictedDecision,
  deviceAnomaly,
  duplicateEnrollment,
  fallbackAbuse,
  identityCollision,
  neverSeen,
  orphanPunches,
  paidWithoutPresence,
  RULE_CATALOGUE,
  robotRegularity,
  SEVERITY_WEIGHT,
  terminatedButActive,
} from './detection-rules.js';

const NOW = new Date('2026-09-23T10:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe('R5 · never seen', () => {
  it('names a worker who has been on the books a fortnight and never clocked in', () => {
    const found = neverSeen(
      [{ employeeId: 'ghost', hireDate: daysAgo(29), punches: 0, siteId: 'site-a' }],
      { days: 14 },
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.employeeId).toBe('ghost');
    expect(found[0]?.evidence).toEqual({
      daysOnTheBooks: 29,
      punches: 0,
      hiredOn: '2026-08-25',
    });
    // One finding per worker, ever: asking again tomorrow changes nothing.
    expect(found[0]?.dedupeKey).toBe('R5:ghost');
  });

  it('leaves alone a new starter, and anybody who has ever clocked in', () => {
    const found = neverSeen(
      [
        { employeeId: 'new-starter', hireDate: daysAgo(3), punches: 0 },
        { employeeId: 'works-here', hireDate: daysAgo(200), punches: 1 },
      ],
      { days: 14 },
      NOW,
    );

    expect(found).toEqual([]);
  });

  it('moves with its threshold, which is what the report’s tuning table shows', () => {
    const worker = [{ employeeId: 'maybe', hireDate: daysAgo(20), punches: 0 }];

    expect(neverSeen(worker, { days: 14 }, NOW)).toHaveLength(1);
    expect(neverSeen(worker, { days: 30 }, NOW)).toHaveLength(0);
  });
});

describe('R4 · bilocation', () => {
  it('asks about a worker only once the overlaps repeat', () => {
    const counts = [
      { employeeId: 'twice', overlaps: 2, siteNames: ['Ridge', 'Airport'] },
      { employeeId: 'thrice', overlaps: 3, siteNames: ['Ridge', 'Airport'], siteId: 'site-a' },
    ];

    const found = bilocation(counts, { overlaps: 3, days: 30 }, NOW);

    // One overlap is a bad night; three in a month is a question.
    expect(found.map((row) => row.employeeId)).toEqual(['thrice']);
    expect(found[0]?.evidence).toEqual({ overlaps: 3, sites: ['Ridge', 'Airport'] });
  });

  it('asks again next month, but not again tomorrow', () => {
    const counts = [{ employeeId: 'twice-over', overlaps: 4, siteNames: ['Ridge', 'Airport'] }];
    const nextDay = new Date('2026-09-24T10:00:00.000Z');
    const nextMonth = new Date('2026-10-02T10:00:00.000Z');

    const today = bilocation(counts, { overlaps: 3, days: 30 }, NOW)[0]?.dedupeKey;
    const tomorrow = bilocation(counts, { overlaps: 3, days: 30 }, nextDay)[0]?.dedupeKey;
    const later = bilocation(counts, { overlaps: 3, days: 30 }, nextMonth)[0]?.dedupeKey;

    expect(tomorrow).toBe(today);
    expect(later).not.toBe(today);
  });
});

describe('R10 · orphan punches', () => {
  it('names a device whose user numbers match nobody, again and again', () => {
    const found = orphanPunches(
      [
        { deviceId: 'gate', deviceName: 'ACC-01', punches: 6, numbersTried: ['9001', '9002'] },
        { deviceId: 'quiet', deviceName: 'ACC-02', punches: 1, numbersTried: ['7777'] },
      ],
      { punches: 5, days: 7 },
      NOW,
    );

    expect(found.map((row) => row.deviceId)).toEqual(['gate']);
    // The numbers tried are what tells probing apart from a typo.
    expect(found[0]?.evidence.numbersTried).toEqual(['9001', '9002']);
  });

  it('keeps at most twenty numbers, so one broken terminal cannot fill a row', () => {
    const many = Array.from({ length: 50 }, (_, index) => String(index));

    const found = orphanPunches(
      [{ deviceId: 'flood', deviceName: 'ACC-03', punches: 50, numbersTried: many }],
      { punches: 5, days: 7 },
      NOW,
    );

    expect(found[0]?.evidence.numbersTried).toHaveLength(20);
  });
});

describe('R1 · duplicate enrollment', () => {
  it('puts a waiting duplicate review where an investigator sees it', () => {
    const found = duplicateEnrollment(
      [
        {
          credentialId: 'face-1',
          employeeId: 'abena',
          lookedLikeStaffNumber: 'SMT-00042',
          similarity: 0.71,
          enrolledAt: daysAgo(4),
          siteId: 'site-a',
        },
      ],
      {},
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toEqual({
      lookedLikeStaffNumber: 'SMT-00042',
      similarity: 0.71,
      credentialId: 'face-1',
    });
    // Never a template and never an image — only what the duplicate queue
    // already shows an ADMIN.
    expect(JSON.stringify(found)).not.toMatch(/template|embedding/i);
  });
});

describe('R2 · identity collision', () => {
  it('asks about a shared phone once per person, naming the others', () => {
    const found = identityCollision(
      [
        {
          kind: 'phone',
          value: '+233200000111',
          employeeIds: ['kofi', 'ama'],
          staffNumbers: ['SMT-00010', 'SMT-00011'],
        },
        {
          kind: 'phone',
          value: '+233200000222',
          employeeIds: ['alone'],
          staffNumbers: ['SMT-00012'],
        },
      ],
      { sharedBy: 2 },
      NOW,
      Buffer.from('a-test-key-for-the-fingerprint'),
    );

    // One finding each, so it shows on both people's files.
    expect(found.map((row) => row.employeeId)).toEqual(['kofi', 'ama']);
    expect(found[0]?.evidence.withStaffNumbers).toEqual(['SMT-00010', 'SMT-00011']);
    // The number itself is not in the evidence: the question is that it is
    // shared, not what it is.
    expect(JSON.stringify(found)).not.toContain('+233200000111');
  });
});

describe('R7 · fallback abuse', () => {
  it('counts the share, not the count, and ignores somebody with barely any', () => {
    const found = fallbackAbuse(
      [
        // Half of them went round the camera: a question.
        { employeeId: 'avoider', clockIns: 20, flagged: 10, siteId: 'site-a' },
        // A bad week, not a pattern.
        { employeeId: 'normal', clockIns: 20, flagged: 4 },
        // Two out of three, but only three: too few to mean anything.
        { employeeId: 'new', clockIns: 3, flagged: 2 },
      ],
      [],
      { sharePercent: 40, days: 30, minimumClockIns: 5, supervisorCoSigns: 20 },
      NOW,
    );

    expect(found.map((row) => row.employeeId)).toEqual(['avoider']);
    expect(found[0]?.evidence).toEqual({ clockIns: 20, flagged: 10, sharePercent: 50 });
  });

  it('counts the supervisor doing the letting in, not only the worker', () => {
    const found = fallbackAbuse(
      [],
      [
        { employeeId: 'busy-supervisor', coSigns: 25 },
        { employeeId: 'ordinary-supervisor', coSigns: 4 },
      ],
      { sharePercent: 40, days: 30, minimumClockIns: 5, supervisorCoSigns: 20 },
      NOW,
    );

    // The supervisor is the likelier of the two to be selling it.
    expect(found.map((row) => row.employeeId)).toEqual(['busy-supervisor']);
    expect(found[0]?.evidence).toEqual({ coSigned: 25, as: 'supervisor' });
    expect(found[0]?.dedupeKey).toContain('supervisor');
  });
});

describe('R8 · robot regularity', () => {
  const sameEveryDay = (minute: number, days: number) => Array.from({ length: days }, () => minute);

  it('names a row of arrivals too alike to be a person', () => {
    const found = robotRegularity(
      [
        // 05:59 to the minute, every day for a fortnight.
        { employeeId: 'too-perfect', minutesOfDay: sameEveryDay(359, 14), siteId: 'site-a' },
        // A real guard: traffic, a tro-tro, a child to drop off.
        {
          employeeId: 'human',
          minutesOfDay: [352, 364, 358, 371, 349, 366, 355, 361, 347, 369, 357, 363],
        },
      ],
      { standardDeviationMinutes: 3, workingDays: 10 },
      NOW,
      daysAgo(30),
    );

    expect(found.map((row) => row.employeeId)).toEqual(['too-perfect']);
    expect(found[0]?.evidence.days).toBe(14);
    expect(found[0]?.evidence.spreadMinutes).toBe(0);
    // The clock face explains itself in a way the statistic does not.
    expect(found[0]?.evidence.usualTime).toBe('05:59');
  });

  it('knows a clock is a circle, so a night shift is not exempt', () => {
    // 23:58, 00:02, 23:59, 00:01 — four minutes apart, not twenty-three
    // hours and fifty-six. A guard on nights is exactly the person this rule
    // is about, so treating the times as points on a line would miss them.
    const aroundMidnight = [1438, 2, 1439, 1, 1438, 0, 2, 1439, 1, 0, 1438, 2];

    const found = robotRegularity(
      [{ employeeId: 'night-shift', minutesOfDay: aroundMidnight }],
      { standardDeviationMinutes: 3, workingDays: 10 },
      NOW,
      daysAgo(30),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.evidence.spreadMinutes).toBeLessThan(3);
    // The middle of those times is midnight itself, not the middle of the
    // number line, which would have been the middle of the afternoon.
    expect(found[0]?.evidence.usualTime).toMatch(/^00:0[01]$|^23:5[89]$/);
  });

  it('waits for enough days before calling anything a pattern', () => {
    const threeIdenticalDays = [{ employeeId: 'new', minutesOfDay: sameEveryDay(359, 3) }];

    expect(
      robotRegularity(
        threeIdenticalDays,
        { standardDeviationMinutes: 3, workingDays: 10 },
        NOW,
        daysAgo(30),
      ),
    ).toEqual([]);
  });
});

describe('R9 · device anomaly', () => {
  const steady = Array.from({ length: 20 }, () => 40);

  it('notices a terminal sending far more than it ever has', () => {
    const found = deviceAnomaly(
      [
        {
          deviceId: 'spiking',
          deviceName: 'ACC-01',
          dailyCounts: [...steady, 200],
          clockDriftSeconds: 0,
        },
        {
          deviceId: 'busy',
          deviceName: 'ACC-02',
          dailyCounts: [...steady, 45],
          clockDriftSeconds: 0,
        },
      ],
      { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 },
      NOW,
      daysAgo(30),
    );

    // Against its own history, never against another device: a busy gate is
    // not an anomaly and a quiet one is not innocent.
    expect(found.map((row) => row.deviceId)).toEqual(['spiking']);
    expect(found[0]?.evidence.multiple).toBe(5);
    expect(found[0]?.evidence.medianPunches).toBe(40);
  });

  it('notices a clock that has wandered, in either direction', () => {
    const found = deviceAnomaly(
      [
        { deviceId: 'fast', deviceName: 'ACC-03', dailyCounts: steady, clockDriftSeconds: 900 },
        { deviceId: 'slow', deviceName: 'ACC-04', dailyCounts: steady, clockDriftSeconds: -600 },
        { deviceId: 'right', deviceName: 'ACC-05', dailyCounts: steady, clockDriftSeconds: 30 },
      ],
      { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 },
      NOW,
      daysAgo(30),
    );

    // A terminal running fast makes a late arrival look punctual every day,
    // with nobody touching a record.
    expect(found.map((row) => row.deviceId).sort()).toEqual(['fast', 'slow']);
    expect(found.find((row) => row.deviceId === 'fast')?.evidence.fast).toBe(true);
    expect(found.find((row) => row.deviceId === 'slow')?.evidence.fast).toBe(false);
  });

  it('raises a wandering clock once a month, not once a sweep', () => {
    const drifting = [
      { deviceId: 'fast', deviceName: 'ACC-03', dailyCounts: steady, clockDriftSeconds: 900 },
    ];
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const nextMonth = new Date('2026-10-02T10:00:00.000Z');
    const thresholds = { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 };

    const today = deviceAnomaly(drifting, thresholds, NOW, daysAgo(30))[0]?.dedupeKey;
    const again = deviceAnomaly(drifting, thresholds, tomorrow, daysAgo(30))[0]?.dedupeKey;
    const later = deviceAnomaly(drifting, thresholds, nextMonth, daysAgo(30))[0]?.dedupeKey;

    // A drifting clock is one standing fact, not a daily event. Raising it
    // every sweep is how a queue becomes wallpaper.
    expect(again).toBe(today);
    expect(later).not.toBe(today);
  });

  it('says nothing about a device with barely any history', () => {
    const found = deviceAnomaly(
      [{ deviceId: 'new', deviceName: 'ACC-06', dailyCounts: [1, 90], clockDriftSeconds: 0 }],
      { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 },
      NOW,
      daysAgo(30),
    );

    expect(found).toEqual([]);
  });
});

describe('R11 · conflicted decision', () => {
  const decision = {
    kind: 'duplicate review' as const,
    recordId: 'face-9',
    employeeIds: ['abena', 'grace'],
    subjectEmployeeId: 'abena',
    decidedByUserId: 'admin-one',
    decidedAt: daysAgo(2),
  };

  it('finds nothing when the two-person rule held, which is the normal answer', () => {
    const found = conflictedDecision(
      [decision],
      [
        { employeeId: 'abena', userId: 'admin-two', did: 'enrolled', at: daysAgo(30) },
        { employeeId: 'grace', userId: 'admin-three', did: 'enrolled', at: daysAgo(30) },
      ],
      {},
      NOW,
    );

    // This rule is a backstop, not a detector: an empty answer is the one
    // it should almost always give.
    expect(found).toEqual([]);
  });

  it('does not report a decision for the wipe that the decision itself made', () => {
    // Settling a duplicate as one person wipes the losing record, stamped
    // with the decider's own name in the same breath as the decision. Every
    // by-the-book resolution would otherwise report itself, and the rule
    // would be noise inside a week.
    const found = conflictedDecision(
      [decision],
      [
        { employeeId: 'grace', userId: 'admin-one', did: 'wiped', at: decision.decidedAt },
        { employeeId: 'abena', userId: 'admin-two', did: 'enrolled', at: daysAgo(30) },
      ],
      {},
      NOW,
    );

    expect(found).toEqual([]);
  });

  it('names a decision settled by somebody who had already had a hand in it', () => {
    const found = conflictedDecision(
      [decision],
      [
        // The same ADMIN enrolled the other record's face, then decided
        // whether the two were the same person.
        { employeeId: 'grace', userId: 'admin-one', did: 'enrolled', at: daysAgo(30) },
        { employeeId: 'abena', userId: 'admin-two', did: 'enrolled', at: daysAgo(30) },
      ],
      {},
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.employeeId).toBe('abena');
    expect(found[0]?.evidence.alsoDid).toEqual(['enrolled']);
    // The history is with Grace, though the alert lands on Abena's file: a
    // checker cannot act on an alert that does not say which.
    expect(found[0]?.evidence.concerningEmployeeIds).toEqual(['grace']);
    expect(found[0]?.dedupeKey).toBe('R11:review:face-9');
    // An alert about a decision is not a file on the person who made it.
    expect(JSON.stringify(found)).not.toMatch(/name|email/i);
  });

  it('lists every way the same person was already involved, once each', () => {
    const found = conflictedDecision(
      [decision],
      [
        { employeeId: 'abena', userId: 'admin-one', did: 'wiped', at: daysAgo(30) },
        { employeeId: 'abena', userId: 'admin-one', did: 'withdrew', at: daysAgo(30) },
        { employeeId: 'grace', userId: 'admin-one', did: 'wiped', at: daysAgo(30) },
      ],
      {},
      NOW,
    );

    expect(found[0]?.evidence.alsoDid).toEqual(['wiped', 'withdrew']);
  });

  it('tells an exemption apart from a duplicate review', () => {
    const found = conflictedDecision(
      [
        {
          kind: 'exemption',
          recordId: 'exemption-3',
          employeeIds: ['kwame'],
          subjectEmployeeId: 'kwame',
          decidedByUserId: 'admin-one',
          decidedAt: daysAgo(1),
        },
      ],
      [{ employeeId: 'kwame', userId: 'admin-one', did: 'withdrew', at: daysAgo(30) }],
      {},
      NOW,
    );

    expect(found[0]?.dedupeKey).toBe('R11:exemption:exemption-3');
    expect(found[0]?.evidence.decision).toBe('exemption');
  });
});

describe('R11 · the decider’s own account', () => {
  const decision = {
    kind: 'duplicate review' as const,
    recordId: 'face-7',
    employeeIds: ['abena', 'grace'],
    subjectEmployeeId: 'abena',
    decidedByUserId: 'admin-two',
    decidedAt: daysAgo(1),
  };

  it('flags a decision by somebody whose account was made by the worker’s handler', () => {
    const found = conflictedDecision(
      [decision],
      // The decider touched nothing. But the administrator who enrolled
      // Grace's face is the one who created the decider's account.
      [{ employeeId: 'grace', userId: 'admin-one', did: 'enrolled', at: daysAgo(30) }],
      {},
      NOW,
      new Map([['admin-two', ['admin-one']]]),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.evidence.accountMadeByWhoAlsoDid).toEqual(['enrolled']);
    // The decider themselves did nothing, and the evidence says so.
    expect(found[0]?.evidence.alsoDid).toEqual([]);
    expect(found[0]?.evidence.concerningEmployeeIds).toEqual(['grace']);
  });

  it('says nothing when the two are really two people', () => {
    const found = conflictedDecision(
      [decision],
      [{ employeeId: 'grace', userId: 'admin-one', did: 'enrolled', at: daysAgo(30) }],
      {},
      NOW,
      // The decider's account was made by somebody else entirely.
      new Map([['admin-two', ['admin-three']]]),
    );

    expect(found).toEqual([]);
  });

  it('says nothing when nobody made the decider’s account', () => {
    // The seed and the rescue script leave nobody named, and an account made
    // under the sole-administrator shortcut names nobody either.
    const found = conflictedDecision(
      [decision],
      [{ employeeId: 'grace', userId: 'admin-one', did: 'enrolled', at: daysAgo(30) }],
      {},
      NOW,
      new Map(),
    );

    expect(found).toEqual([]);
  });

  it('counts only a hand held before the decision, through an account as well', () => {
    const found = conflictedDecision(
      [decision],
      // Stamped in the same breath as the decision, as a by-the-book
      // resolution does.
      [{ employeeId: 'grace', userId: 'admin-one', did: 'wiped', at: decision.decidedAt }],
      {},
      NOW,
      new Map([['admin-two', ['admin-one']]]),
    );

    expect(found).toEqual([]);
  });
});

describe('R3 · paid without presence', () => {
  const line = {
    lineId: 'line-1',
    runId: 'run-1',
    employeeId: 'ghost',
    period: '2026-08',
    periodStartsOn: new Date('2026-08-01T00:00:00.000Z'),
    periodEndsOn: new Date('2026-08-31T00:00:00.000Z'),
    paidMinutes: 9600,
    presentMinutes: 9600,
    manualMinutes: 0,
    fallbackMinutes: 0,
  };

  it('says nothing when the shifts behind a payslip cover it', () => {
    expect(paidWithoutPresence([line], { toleranceMinutes: 60 }, NOW)).toEqual([]);
  });

  it('names a payslip paying for a month nobody worked', () => {
    const found = paidWithoutPresence(
      [{ ...line, presentMinutes: 0 }],
      { toleranceMinutes: 60 },
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.employeeId).toBe('ghost');
    expect(found[0]?.evidence).toEqual({
      period: '2026-08',
      runId: 'run-1',
      lineId: 'line-1',
      paidMinutes: 9600,
      presentMinutes: 0,
      beyondToleranceMinutes: 9540,
      manualMinutes: 0,
      fallbackMinutes: 0,
    });
    // The window is the period, not the sweep: an investigator opens August.
    expect(found[0]?.windowFrom).toEqual(line.periodStartsOn);
    expect(found[0]?.windowTo).toEqual(line.periodEndsOn);
    // One per line, ever. A submitted line never changes again.
    expect(found[0]?.dedupeKey).toBe('R3:line-1');
  });

  it('forgives a shift rounded to the minute, and moves with its threshold', () => {
    const overByAnHour = [{ ...line, paidMinutes: 9660 }];

    expect(paidWithoutPresence(overByAnHour, { toleranceMinutes: 60 }, NOW)).toEqual([]);
    expect(paidWithoutPresence(overByAnHour, { toleranceMinutes: 30 }, NOW)).toHaveLength(1);
  });

  it('carries the split, so a checker sees what the hours rest on', () => {
    const found = paidWithoutPresence(
      // Nine hundred minutes present, and every one of them typed in by hand.
      [{ ...line, presentMinutes: 900, manualMinutes: 900, fallbackMinutes: 0 }],
      { toleranceMinutes: 60 },
      NOW,
    );

    expect(found[0]?.evidence.manualMinutes).toBe(900);
    expect(found[0]?.evidence.presentMinutes).toBe(900);
  });

  it('says nothing about money, only about minutes', () => {
    const found = paidWithoutPresence(
      [{ ...line, presentMinutes: 0 }],
      { toleranceMinutes: 60 },
      NOW,
    );

    expect(JSON.stringify(found)).not.toMatch(/pesewa|net|gross|bank/i);
  });
});

describe('R6 · terminated but active', () => {
  const leaver = {
    employeeId: 'kojo',
    siteId: 'site-a',
    leftOn: new Date('2026-06-15T00:00:00.000Z'),
    punchesAfter: 0,
    paidPeriods: [] as { period: string; startsOn: Date }[],
  };
  const month = (year: number, month: number) => ({
    period: `${year}-${String(month).padStart(2, '0')}`,
    startsOn: new Date(Date.UTC(year, month - 1, 1)),
  });

  it('leaves alone somebody who left and stopped', () => {
    expect(terminatedButActive([leaver], {}, NOW)).toEqual([]);
  });

  it('names a leaver who is still clocking in', () => {
    const found = terminatedButActive(
      [{ ...leaver, punchesAfter: 14, lastPunchOn: '2026-09-22' }],
      {},
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.employeeId).toBe('kojo');
    expect(found[0]?.siteId).toBe('site-a');
    expect(found[0]?.evidence).toEqual({
      leftOn: '2026-06-15',
      punchesAfter: 14,
      lastPunchOn: '2026-09-22',
      paidPeriodsAfter: [],
    });
  });

  it('names a leaver who is still being paid, with no punches at all', () => {
    const found = terminatedButActive(
      [{ ...leaver, paidPeriods: [month(2026, 8), month(2026, 7)] }],
      {},
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.evidence.paidPeriodsAfter).toEqual(['2026-07', '2026-08']);
    expect(found[0]?.evidence.punchesAfter).toBe(0);
  });

  it('does not count the month they left in, only the ones that began after', () => {
    // Left on the 15th of June: June's payslip covers the days they worked,
    // and May's is history. July's is the question.
    const found = terminatedButActive(
      [{ ...leaver, paidPeriods: [month(2026, 5), month(2026, 6), month(2026, 7)] }],
      {},
      NOW,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.evidence.paidPeriodsAfter).toEqual(['2026-07']);
  });

  it('treats a period beginning on the leaving day itself as theirs', () => {
    // Left on the first of the month: that month's payslip pays one day.
    const leftOnTheFirst = { ...leaver, leftOn: new Date('2026-07-01T00:00:00.000Z') };

    expect(
      terminatedButActive([{ ...leftOnTheFirst, paidPeriods: [month(2026, 7)] }], {}, NOW),
    ).toEqual([]);
    expect(
      terminatedButActive([{ ...leftOnTheFirst, paidPeriods: [month(2026, 8)] }], {}, NOW),
    ).toHaveLength(1);
  });

  it('asks again next month, but not again tomorrow', () => {
    const still = [{ ...leaver, punchesAfter: 1 }];
    const tomorrow = new Date('2026-09-24T10:00:00.000Z');
    const nextMonth = new Date('2026-10-01T10:00:00.000Z');

    const today = terminatedButActive(still, {}, NOW)[0]?.dedupeKey;

    expect(terminatedButActive(still, {}, tomorrow)[0]?.dedupeKey).toBe(today);
    expect(terminatedButActive(still, {}, nextMonth)[0]?.dedupeKey).not.toBe(today);
  });
});

describe('the catalogue', () => {
  it('has all eleven rules, and every one of them is built', () => {
    expect(RULE_CATALOGUE).toHaveLength(11);
    // A rule that is not built yet must never read as a clean bill of health.
    expect(RULE_CATALOGUE.filter((rule) => rule.built).map((rule) => rule.code)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R10',
      'R11',
    ]);
  });

  it('weighs a critical alert five times a medium one', () => {
    expect(SEVERITY_WEIGHT.CRITICAL).toBe(10);
    expect(SEVERITY_WEIGHT.HIGH).toBe(5);
    expect(SEVERITY_WEIGHT.MEDIUM).toBe(2);
  });
});
