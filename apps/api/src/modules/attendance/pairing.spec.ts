import { describe, expect, it } from 'vitest';
import {
  basisFor,
  type Direction,
  newSegmentRef,
  type PairablePunch,
  type PunchMethod,
  pairPunches,
  planExceptions,
  planSegments,
  type StoredSegment,
  shiftBasis,
} from './pairing.js';

const SITE = 'site-a';
const OTHER_SITE = 'site-b';
const now = new Date('2026-09-22T12:00:00Z');
const windowStart = new Date('2026-07-22T12:00:00Z');

let counter = 0;
function punch(
  time: string,
  direction: Direction,
  siteId = SITE,
  method: PairablePunch['method'] = 'FINGERPRINT',
): PairablePunch {
  counter += 1;
  return {
    id: `p${String(counter).padStart(3, '0')}`,
    siteId,
    deviceTime: new Date(time),
    direction,
    method,
  };
}

const span = (pairing: ReturnType<typeof pairPunches>) =>
  pairing.shifts.map(({ clockIn, clockOut }) => [
    clockIn.deviceTime.toISOString().slice(5, 16),
    clockOut.deviceTime.toISOString().slice(5, 16),
  ]);

describe('pairPunches', () => {
  it('pairs an IN with the next OUT at the same site', () => {
    const pairing = pairPunches(
      [punch('2026-09-20T06:02:00Z', 'IN'), punch('2026-09-20T18:05:00Z', 'OUT')],
      now,
    );
    expect(span(pairing)).toEqual([['09-20T06:02', '09-20T18:05']]);
    expect(pairing.missingClockIn).toEqual([]);
    expect(pairing.missingClockOut).toEqual([]);
  });

  it('pairs a night shift across midnight as one 8-hour shift', () => {
    const clockIn = punch('2026-09-20T22:00:00Z', 'IN');
    const clockOut = punch('2026-09-21T06:00:00Z', 'OUT');
    const [shift] = pairPunches([clockOut, clockIn], now).shifts;
    expect(shift?.clockIn).toBe(clockIn);
    expect(shift?.clockOut).toBe(clockOut);
    expect((clockOut.deviceTime.getTime() - clockIn.deviceTime.getTime()) / 60_000).toBe(480);
  });

  it('never pairs across more than 16 hours', () => {
    const clockIn = punch('2026-09-20T06:00:00Z', 'IN');
    const clockOut = punch('2026-09-20T22:00:01Z', 'OUT');
    const pairing = pairPunches([clockIn, clockOut], now);
    expect(pairing.shifts).toEqual([]);
    expect(pairing.missingClockOut).toEqual([clockIn]);
    expect(pairing.missingClockIn).toEqual([clockOut]);
  });

  it('pairs exactly 16 hours', () => {
    const pairing = pairPunches(
      [punch('2026-09-20T06:00:00Z', 'IN'), punch('2026-09-20T22:00:00Z', 'OUT')],
      now,
    );
    expect(pairing.shifts).toHaveLength(1);
  });

  it('never pairs punches from two different sites', () => {
    const clockIn = punch('2026-09-20T06:00:00Z', 'IN', SITE);
    const clockOut = punch('2026-09-20T18:00:00Z', 'OUT', OTHER_SITE);
    const pairing = pairPunches([clockIn, clockOut], now);
    expect(pairing.shifts).toEqual([]);
    expect(pairing.missingClockOut).toEqual([clockIn]);
    expect(pairing.missingClockIn).toEqual([clockOut]);
  });

  it('pairs each site on its own, so two shifts at once both appear', () => {
    const pairing = pairPunches(
      [
        punch('2026-09-20T06:00:00Z', 'IN', SITE),
        punch('2026-09-20T10:00:00Z', 'IN', OTHER_SITE),
        punch('2026-09-20T12:00:00Z', 'OUT', OTHER_SITE),
        punch('2026-09-20T18:00:00Z', 'OUT', SITE),
      ],
      now,
    );
    expect(span(pairing).sort()).toEqual([
      ['09-20T06:00', '09-20T18:00'],
      ['09-20T10:00', '09-20T12:00'],
    ]);
  });

  it('ignores a repeat tap within 2 minutes', () => {
    const first = punch('2026-09-20T06:00:00Z', 'IN');
    const again = punch('2026-09-20T06:01:30Z', 'IN');
    const out = punch('2026-09-20T18:00:00Z', 'OUT');
    const outAgain = punch('2026-09-20T18:00:40Z', 'UNKNOWN');
    const pairing = pairPunches([first, again, out, outAgain], now);
    expect(pairing.shifts).toEqual([{ clockIn: first, clockOut: out }]);
    expect(pairing.missingClockIn).toEqual([]);
    expect(pairing.missingClockOut).toEqual([]);
  });

  it('treats a chain of quick taps as one act, even when the chain lasts longer than 2 minutes', () => {
    const first = punch('2026-09-20T06:00:00Z', 'IN');
    const taps = [first, punch('2026-09-20T06:01:30Z', 'IN'), punch('2026-09-20T06:03:00Z', 'IN')];
    const out = punch('2026-09-20T18:00:00Z', 'OUT');
    const pairing = pairPunches([...taps, out], now);
    expect(pairing.shifts).toEqual([{ clockIn: first, clockOut: out }]);
    expect(pairing.missingClockOut).toEqual([]);
  });

  it('never swallows a real clock-out that follows an UNKNOWN clock-in within 2 minutes', () => {
    const unknownIn = punch('2026-09-20T09:00:00Z', 'UNKNOWN');
    const out = punch('2026-09-20T09:01:30Z', 'OUT');
    expect(pairPunches([unknownIn, out], now).shifts).toEqual([
      { clockIn: unknownIn, clockOut: out },
    ]);
  });

  it('treats an OUT right after an UNKNOWN that closed the shift as the same act', () => {
    const clockIn = punch('2026-09-20T06:00:00Z', 'IN');
    const unknownOut = punch('2026-09-20T18:00:00Z', 'UNKNOWN');
    const again = punch('2026-09-20T18:01:00Z', 'OUT');
    const pairing = pairPunches([clockIn, unknownOut, again], now);
    expect(pairing.shifts).toEqual([{ clockIn, clockOut: unknownOut }]);
    expect(pairing.missingClockIn).toEqual([]);
  });

  it('treats a second IN after 2 minutes as a new clock-in, and the first as missing its OUT', () => {
    const first = punch('2026-09-20T06:00:00Z', 'IN');
    const second = punch('2026-09-20T06:03:00Z', 'IN');
    const pairing = pairPunches([first, second, punch('2026-09-20T18:00:00Z', 'OUT')], now);
    expect(pairing.shifts[0]?.clockIn).toBe(second);
    expect(pairing.missingClockOut).toEqual([first]);
  });

  it('reads UNKNOWN as OUT while a clock-in is open, otherwise as IN', () => {
    const pairing = pairPunches(
      [
        punch('2026-09-20T06:00:00Z', 'UNKNOWN'),
        punch('2026-09-20T18:00:00Z', 'UNKNOWN'),
        punch('2026-09-21T06:00:00Z', 'UNKNOWN'),
        punch('2026-09-21T18:00:00Z', 'UNKNOWN'),
      ],
      now,
    );
    expect(span(pairing)).toEqual([
      ['09-20T06:00', '09-20T18:00'],
      ['09-21T06:00', '09-21T18:00'],
    ]);
  });

  it('makes two touching shifts at a same-second handover (OUT sorts first)', () => {
    const pairing = pairPunches(
      [
        punch('2026-09-20T18:00:00Z', 'IN'),
        punch('2026-09-20T06:00:00Z', 'IN'),
        punch('2026-09-20T18:00:00Z', 'OUT'),
        punch('2026-09-21T06:00:00Z', 'OUT'),
      ],
      now,
    );
    expect(span(pairing)).toEqual([
      ['09-20T06:00', '09-20T18:00'],
      ['09-20T18:00', '09-21T06:00'],
    ]);
  });

  it('leaves a recent clock-in open (a shift in progress) until 16 hours pass', () => {
    const recent = punch('2026-09-22T06:00:00Z', 'IN');
    expect(pairPunches([recent], now).missingClockOut).toEqual([]);
    const overdue = punch('2026-09-21T19:59:00Z', 'IN');
    expect(pairPunches([overdue], now).missingClockOut).toEqual([overdue]);
  });

  it('gives the same answer whatever order the punches arrive in', () => {
    const punches = [
      punch('2026-09-18T06:00:00Z', 'IN'),
      punch('2026-09-18T18:00:00Z', 'OUT'),
      punch('2026-09-19T05:59:00Z', 'IN'),
      punch('2026-09-19T06:00:10Z', 'IN'),
      punch('2026-09-19T18:02:00Z', 'UNKNOWN'),
      punch('2026-09-20T22:00:00Z', 'IN', OTHER_SITE),
      punch('2026-09-21T06:00:00Z', 'OUT', OTHER_SITE),
      punch('2026-09-21T09:00:00Z', 'OUT'),
    ];
    const expected = pairPunches(punches, now);
    expect(span(expected)).toEqual([
      ['09-18T06:00', '09-18T18:00'],
      ['09-19T05:59', '09-19T18:02'],
      ['09-20T22:00', '09-21T06:00'],
    ]);
    for (let round = 0; round < 20; round += 1) {
      const shuffled = [...punches].sort(() => Math.random() - 0.5);
      expect(pairPunches(shuffled, now)).toEqual(expected);
    }
  });
});

describe('planSegments', () => {
  const clockIn = punch('2026-09-20T06:00:00Z', 'IN');
  const clockOut = punch('2026-09-20T18:00:00Z', 'OUT');
  const pinOut = punch('2026-09-20T18:00:00Z', 'OUT', SITE, 'PIN_FALLBACK');
  const pairing = pairPunches([clockIn, clockOut], now);

  const stored = (overrides: Partial<StoredSegment>): StoredSegment => ({
    id: 'seg-1',
    siteId: SITE,
    startedAt: clockIn.deviceTime,
    endedAt: clockOut.deviceTime,
    basis: 'BIOMETRIC',
    status: 'CONFIRMED',
    clockInPunchId: clockIn.id,
    clockOutPunchId: clockOut.id,
    voidedByUserId: null,
    ...overrides,
  });

  it('creates a row for a new shift, marked PIN_FALLBACK when a PIN was used', () => {
    expect(planSegments(pairing, [], windowStart).create).toMatchObject([
      { ref: newSegmentRef(clockIn.id, clockOut.id), basis: 'BIOMETRIC', status: 'CONFIRMED' },
    ]);
    const withPin = planSegments(pairPunches([clockIn, pinOut], now), [], windowStart);
    expect(withPin.create[0]?.basis).toBe('PIN_FALLBACK');
  });

  it('changes nothing when the stored rows already match', () => {
    const plan = planSegments(pairing, [stored({})], windowStart);
    expect(plan.create).toEqual([]);
    expect(plan.change).toEqual([]);
  });

  it('voids a derived row that is no longer wanted, but never a hand-added one', () => {
    const plan = planSegments(
      pairPunches([], now),
      [
        stored({}),
        stored({ id: 'manual', basis: 'MANUAL', clockInPunchId: null, clockOutPunchId: null }),
      ],
      windowStart,
    );
    expect(plan.change).toEqual([{ id: 'seg-1', status: 'VOIDED' }]);
  });

  it('brings back a row that re-pairing voided, but never one a person voided', () => {
    const systemVoid = planSegments(pairing, [stored({ status: 'VOIDED' })], windowStart);
    expect(systemVoid.change).toEqual([{ id: 'seg-1', status: 'CONFIRMED' }]);

    const personVoid = planSegments(
      pairing,
      [stored({ status: 'VOIDED', voidedByUserId: 'user-1' })],
      windowStart,
    );
    expect(personVoid.create).toEqual([]);
    expect(personVoid.change).toEqual([]);
    expect(personVoid.live).toEqual([]);
  });

  it('disputes both of two overlapping shifts, and lists the pair', () => {
    const plan = planSegments(
      pairPunches(
        [
          clockIn,
          clockOut,
          punch('2026-09-20T10:00:00Z', 'IN', OTHER_SITE),
          punch('2026-09-20T12:00:00Z', 'OUT', OTHER_SITE),
        ],
        now,
      ),
      [stored({})],
      windowStart,
    );
    expect(plan.change).toEqual([{ id: 'seg-1', status: 'DISPUTED' }]);
    expect(plan.create[0]?.status).toBe('DISPUTED');
    expect(plan.overlaps.map(([a, b]) => [a.ref, b.ref])).toEqual([['seg-1', plan.create[0]?.ref]]);
  });

  it('confirms a disputed shift again once its partner is gone', () => {
    const plan = planSegments(pairing, [stored({ status: 'DISPUTED' })], windowStart);
    expect(plan.change).toEqual([{ id: 'seg-1', status: 'CONFIRMED' }]);
  });

  it('never creates a shift that began before the window', () => {
    const straddling = pairPunches(
      [punch('2026-07-22T08:00:00Z', 'IN'), punch('2026-07-22T14:00:00Z', 'OUT')],
      now,
    );
    const plan = planSegments(straddling, [], windowStart);
    expect(plan.create).toEqual([]);
    expect(plan.live).toEqual([]);
  });

  it('never changes a shift older than the window, but disputes a new one overlapping it', () => {
    const old = stored({
      id: 'old',
      startedAt: new Date('2026-07-22T11:00:00Z'),
      endedAt: new Date('2026-07-22T20:00:00Z'),
      clockInPunchId: 'old-in',
      clockOutPunchId: 'old-out',
    });
    const late = pairPunches(
      [punch('2026-07-22T13:00:00Z', 'IN'), punch('2026-07-22T15:00:00Z', 'OUT')],
      now,
    );
    const plan = planSegments(late, [old], windowStart);
    expect(plan.change).toEqual([]);
    expect(plan.create[0]?.status).toBe('DISPUTED');
    expect(plan.overlaps).toHaveLength(1);
  });
});

describe('planExceptions', () => {
  const exception = (overrides: Record<string, unknown>) => ({
    id: 'ex-1',
    type: 'MISSING_CLOCK_OUT' as const,
    status: 'OPEN' as const,
    dedupeKey: 'MISSING_CLOCK_OUT:p1',
    punchId: 'p1',
    segmentId: null,
    secondSegmentId: null,
    ...overrides,
  });

  it('closes an open one whose problem is gone, only when its punch was checked', () => {
    const closes = planExceptions({
      wantedKeys: new Set(),
      stored: [exception({})],
      checkedPunchIds: new Set(['p1']),
      checkedSegmentIds: new Set(),
    });
    expect(closes.autoClose).toEqual(['ex-1']);

    const notChecked = planExceptions({
      wantedKeys: new Set(),
      stored: [exception({})],
      checkedPunchIds: new Set(),
      checkedSegmentIds: new Set(),
    });
    expect(notChecked.autoClose).toEqual([]);
  });

  it('reopens an auto-closed one when the problem comes back', () => {
    const plan = planExceptions({
      wantedKeys: new Set(['MISSING_CLOCK_OUT:p1']),
      stored: [exception({ status: 'AUTO_CLOSED' })],
      checkedPunchIds: new Set(['p1']),
      checkedSegmentIds: new Set(),
    });
    expect(plan.reopen).toEqual(['ex-1']);
  });

  it('closes an overlap once either of its shifts was checked and it no longer overlaps', () => {
    const plan = planExceptions({
      wantedKeys: new Set(),
      stored: [
        exception({
          type: 'OVERLAP',
          dedupeKey: 'OVERLAP:a:b',
          punchId: null,
          segmentId: 'a',
          secondSegmentId: 'b',
        }),
      ],
      checkedPunchIds: new Set(),
      checkedSegmentIds: new Set(['b']),
    });
    expect(plan.autoClose).toEqual(['ex-1']);
  });
});

describe('basisFor and shiftBasis', () => {
  it('counts a finger, a face, and a face confirmed by the kiosk sensor as biometric', () => {
    expect(basisFor('FINGERPRINT')).toBe('BIOMETRIC');
    expect(basisFor('FACE')).toBe('BIOMETRIC');
    expect(basisFor('FACE_PASSKEY')).toBe('BIOMETRIC');
  });

  it('flags a PIN or co-sign, and a staff number confirmed by the kiosk sensor', () => {
    expect(basisFor('PIN_FALLBACK')).toBe('PIN_FALLBACK');
    expect(basisFor('STAFF_PASSKEY')).toBe('PIN_FALLBACK');
  });

  it('makes a shift only as strong as its weaker punch', () => {
    const shift = (inMethod: PunchMethod, outMethod: PunchMethod) => ({
      clockIn: punch('2026-09-21T06:00:00Z', 'IN', SITE, inMethod),
      clockOut: punch('2026-09-21T18:00:00Z', 'OUT', SITE, outMethod),
    });
    expect(shiftBasis(shift('FACE_PASSKEY', 'FINGERPRINT'))).toBe('BIOMETRIC');
    expect(shiftBasis(shift('FACE_PASSKEY', 'STAFF_PASSKEY'))).toBe('PIN_FALLBACK');
    expect(shiftBasis(shift('PIN_FALLBACK', 'FACE'))).toBe('PIN_FALLBACK');
  });

  it('gives a new segment the basis of its weaker punch', () => {
    const clockIn = punch('2026-09-21T06:00:00Z', 'IN', SITE, 'FACE_PASSKEY');
    const clockOut = punch('2026-09-21T18:00:00Z', 'OUT', SITE, 'STAFF_PASSKEY');
    const pairing = pairPunches([clockIn, clockOut], now);
    const plan = planSegments(pairing, [], windowStart);
    expect(plan.create.map((segment) => segment.basis)).toEqual(['PIN_FALLBACK']);
  });
});
