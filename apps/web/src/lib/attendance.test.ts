import { describe, expect, it } from 'vitest';
import { daysBetween, describeDrift, driftIsSuspect, isFlaggedMethod } from './attendance';

describe('daysBetween', () => {
  it('counts whole days and goes negative when the range is backwards', () => {
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
    expect(daysBetween('2026-09-01', '2026-10-02')).toBe(31);
    expect(daysBetween('2026-09-10', '2026-09-09')).toBe(-1);
  });

  it('is NaN for a date that is not a date', () => {
    expect(daysBetween('', '2026-09-09')).toBeNaN();
  });
});

describe('describeDrift', () => {
  it('says how far a device clock is off, in plain words', () => {
    expect(describeDrift(null)).toBe('—');
    expect(describeDrift(0)).toBe('exact');
    expect(describeDrift(2)).toBe('2 s fast');
    expect(describeDrift(-45)).toBe('45 s slow');
    expect(describeDrift(420)).toBe('7 min fast');
    expect(describeDrift(-3600)).toBe('60 min slow');
  });
});

describe('driftIsSuspect', () => {
  it('flags a clock more than five minutes off, either way', () => {
    expect(driftIsSuspect(null)).toBe(false);
    expect(driftIsSuspect(300)).toBe(false);
    expect(driftIsSuspect(301)).toBe(true);
    expect(driftIsSuspect(-301)).toBe(true);
  });
});

describe('isFlaggedMethod', () => {
  it('flags the methods that do not prove who was there', () => {
    expect(isFlaggedMethod('FINGERPRINT')).toBe(false);
    expect(isFlaggedMethod('FACE')).toBe(false);
    expect(isFlaggedMethod('STAFF_PASSKEY')).toBe(true);
    expect(isFlaggedMethod('PIN_FALLBACK')).toBe(true);
  });
});
