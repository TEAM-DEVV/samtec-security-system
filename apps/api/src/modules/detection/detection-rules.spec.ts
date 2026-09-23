import { describe, expect, it } from 'vitest';
import {
  bilocation,
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

describe('the catalogue', () => {
  it('has all eleven rules, and says which are built', () => {
    expect(RULE_CATALOGUE).toHaveLength(11);
    // A rule that is not built yet must never read as a clean bill of health.
    expect(RULE_CATALOGUE.filter((rule) => rule.built).map((rule) => rule.code)).toEqual([
      'R4',
      'R5',
      'R10',
    ]);
  });

  it('weighs a critical alert five times a medium one', () => {
    expect(SEVERITY_WEIGHT.CRITICAL).toBe(10);
    expect(SEVERITY_WEIGHT.HIGH).toBe(5);
    expect(SEVERITY_WEIGHT.MEDIUM).toBe(2);
  });
});
