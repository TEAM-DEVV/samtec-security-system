import { describe, expect, it } from 'vitest';
import {
  cedisToPesewas,
  firstName,
  formatCedis,
  formatClock,
  formatDate,
  formatDateTime,
  formatLongDate,
  greetingForNow,
  initials,
  previousMonthInGhana,
} from './format';

describe('formatClock', () => {
  it('shows the clock time to the second in Ghana, whatever zone the computer is in', () => {
    expect(formatClock(Date.parse('2026-09-15T08:30:07Z'))).toBe('08:30:07');
    expect(formatClock(new Date('2026-09-15T23:59:59Z'))).toBe('23:59:59');
  });
});

describe('the test environment', () => {
  it('runs far from Ghana, so time zone mistakes cannot hide', () => {
    // Honolulu is 10 hours behind UTC (see vitest.config.ts).
    expect(new Date('2026-09-15T00:00:00Z').getTimezoneOffset()).toBe(600);
  });
});

describe('formatCedis', () => {
  it('shows pesewas as cedis with two decimals', () => {
    expect(formatCedis(123_456)).toBe('GH₵ 1,234.56');
  });

  it('keeps small amounts exact', () => {
    expect(formatCedis(5)).toBe('GH₵ 0.05');
    expect(formatCedis(0)).toBe('GH₵ 0.00');
  });

  it('shows negative amounts, such as payroll corrections', () => {
    expect(formatCedis(-1_050)).toBe('-GH₵ 10.50');
  });

  it('refuses amounts that are not whole pesewas', () => {
    expect(() => formatCedis(10.5)).toThrow(TypeError);
  });
});

describe('cedisToPesewas', () => {
  it('turns a typed cedis amount into whole pesewas', () => {
    expect(cedisToPesewas('15')).toBe(1_500);
    expect(cedisToPesewas('15.5')).toBe(1_550);
    expect(cedisToPesewas('1234.56')).toBe(123_456);
  });

  it('rounds away any floating-point noise', () => {
    expect(cedisToPesewas('19.99')).toBe(1_999);
  });

  it('is NaN for anything that is not a positive amount', () => {
    expect(cedisToPesewas('')).toBeNaN();
    expect(cedisToPesewas('0')).toBeNaN();
    expect(cedisToPesewas('-5')).toBeNaN();
    expect(cedisToPesewas('not a number')).toBeNaN();
  });
});

describe('formatDate', () => {
  it('shows the same calendar date the API sent', () => {
    expect(formatDate('2026-09-15')).toMatch(/^15 Sept? 2026$/);
  });

  it('refuses a timestamp, which needs formatDateTime', () => {
    expect(() => formatDate('2026-09-15T08:30:00Z')).toThrow(TypeError);
  });
});

describe('formatDateTime', () => {
  it('shows timestamps in Ghana time', () => {
    expect(formatDateTime('2026-09-15T08:30:00Z')).toMatch(/^15 Sept? 2026, 08:30$/);
  });
});

describe('previousMonthInGhana', () => {
  it('is the month before the one a moment falls in', () => {
    expect(previousMonthInGhana(new Date('2026-09-15T08:30:00Z'))).toBe('2026-08');
  });

  it('carries back across a year boundary', () => {
    expect(previousMonthInGhana(new Date('2026-01-10T08:30:00Z'))).toBe('2025-12');
  });

  it('judges the date in Ghana, not in the test machine’s own zone', () => {
    // The test machine runs 10 hours behind UTC (Honolulu). Shortly after
    // midnight UTC on the 1st, it is still the last day of the month before in
    // Honolulu, but already the 1st in Ghana — the previous month must be
    // worked out from Ghana's date, not the machine's.
    expect(previousMonthInGhana(new Date('2026-09-01T02:00:00Z'))).toBe('2026-08');
  });
});

describe('formatLongDate', () => {
  it('spells the date out in Ghana time, whatever zone the computer is in', () => {
    // 23:30 UTC on the 15th is still the 15th in Ghana (UTC+0), but the 16th further east.
    expect(formatLongDate(new Date('2026-09-15T23:30:00Z'))).toMatch(
      /^Tuesday,? 15 September 2026$/,
    );
  });
});

describe('greetingForNow', () => {
  it('greets by the clock in Ghana, switching exactly at noon and 17:00', () => {
    expect(greetingForNow(new Date('2026-09-15T00:00:00Z'))).toBe('Good morning');
    expect(greetingForNow(new Date('2026-09-15T11:59:00Z'))).toBe('Good morning');
    expect(greetingForNow(new Date('2026-09-15T12:00:00Z'))).toBe('Good afternoon');
    expect(greetingForNow(new Date('2026-09-15T16:59:00Z'))).toBe('Good afternoon');
    expect(greetingForNow(new Date('2026-09-15T17:00:00Z'))).toBe('Good evening');
  });
});

describe('firstName', () => {
  it('takes the first word, ignoring stray spaces', () => {
    expect(firstName('Kwame Kofi Mensah')).toBe('Kwame');
    expect(firstName('  Efua ')).toBe('Efua');
  });
});

describe('initials', () => {
  it('takes the first and last initials', () => {
    expect(initials('Kwame Kofi Mensah')).toBe('KM');
    expect(initials('Abena Owusu')).toBe('AO');
  });

  it('copes with a single name and stray spaces', () => {
    expect(initials('  Efua ')).toBe('E');
  });
});
