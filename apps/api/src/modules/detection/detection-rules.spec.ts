import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  bilocation,
  duplicateEnrollment,
  fallbackAbuse,
  identityCollision,
  neverSeen,
  orphanPunches,
  RULE_CATALOGUE,
  SEVERITY_WEIGHT,
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

describe('the catalogue', () => {
  it('has all eleven rules, and says which are built', () => {
    expect(RULE_CATALOGUE).toHaveLength(11);
    // A rule that is not built yet must never read as a clean bill of health.
    expect(RULE_CATALOGUE.filter((rule) => rule.built).map((rule) => rule.code)).toEqual([
      'R1',
      'R2',
      'R4',
      'R5',
      'R7',
      'R10',
    ]);
  });

  it('weighs a critical alert five times a medium one', () => {
    expect(SEVERITY_WEIGHT.CRITICAL).toBe(10);
    expect(SEVERITY_WEIGHT.HIGH).toBe(5);
    expect(SEVERITY_WEIGHT.MEDIUM).toBe(2);
  });
});
