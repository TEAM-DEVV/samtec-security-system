import { describe, expect, it } from 'vitest';
import {
  firstName,
  formatCedis,
  formatDate,
  formatDateTime,
  formatLongDate,
  greetingForNow,
  initials,
} from './format';

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
