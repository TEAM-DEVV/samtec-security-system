import { describe, expect, it } from 'vitest';
import { toAccraDate, toIsoDate } from './dates.js';

describe('toIsoDate', () => {
  it('keeps only the calendar date', () => {
    expect(toIsoDate(new Date('2026-09-15T00:00:00Z'))).toBe('2026-09-15');
  });

  it('never shifts the date, even at the end of a day', () => {
    expect(toIsoDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
  });
});

describe('toAccraDate', () => {
  it('gives the Ghana date of a moment', () => {
    expect(toAccraDate(new Date('2026-09-21T22:00:00Z'))).toBe('2026-09-21');
    expect(toAccraDate(new Date('2026-09-22T00:30:00Z'))).toBe('2026-09-22');
  });
});
