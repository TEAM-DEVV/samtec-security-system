import { describe, expect, it } from 'vitest';
import { evidenceLabel, evidenceText } from './detection';

describe('evidenceText', () => {
  it('reads whole minutes as hours and minutes', () => {
    expect(evidenceText('paidMinutes', 15_840)).toBe('264h 00m');
  });

  it('never crashes on a tenth of a minute, which R8 and R9 both send', () => {
    // R8's spread and R9's clock drift are rounded to one decimal place.
    expect(evidenceText('spreadMinutes', 2.7)).toBe('2.7 min');
    expect(evidenceText('clockDriftMinutes', 5.3)).toBe('5.3 min');
  });

  it('reads lists, yes-or-no and missing values in plain words', () => {
    expect(evidenceText('paidPeriodsAfter', ['2026-06', '2026-07'])).toBe('2026-06, 2026-07');
    expect(evidenceText('paidPeriodsAfter', [])).toBe('—');
    expect(evidenceText('fast', true)).toBe('Yes');
    expect(evidenceText('lastPunchOn', null)).toBe('—');
  });
});

describe('evidenceLabel', () => {
  it('uses the written label, and spaces out a key nobody has labelled yet', () => {
    expect(evidenceLabel('beyondToleranceMinutes')).toBe('Unexplained');
    expect(evidenceLabel('someNewThing')).toBe('Some new thing');
  });
});
