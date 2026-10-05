import { describe, expect, it } from 'vitest';
import { MAX_MONEY_PESEWAS, parseCedisInput, pesewasToCedisInput } from './payroll';

describe('reading a cedis amount typed into the Pay card', () => {
  it('turns plain amounts into whole pesewas, exactly', () => {
    expect(parseCedisInput('1200')).toBe(120_000);
    expect(parseCedisInput('1234.56')).toBe(123_456);
    expect(parseCedisInput('1,234.56')).toBe(123_456);
    expect(parseCedisInput(' 7.30 ')).toBe(730);
    expect(parseCedisInput('0.5')).toBe(50);
    expect(parseCedisInput('0')).toBe(0);
  });

  it('never goes through floating point: the classic rounding trap is exact', () => {
    // 19.99 * 100 is 1998.9999999999998 in floating point; this must be 1999.
    expect(parseCedisInput('19.99')).toBe(1_999);
    expect(parseCedisInput('0.29')).toBe(29);
  });

  it('allows the cap itself and refuses one pesewa more', () => {
    expect(parseCedisInput('1000000')).toBe(MAX_MONEY_PESEWAS);
    expect(parseCedisInput('1000000.00')).toBe(MAX_MONEY_PESEWAS);
    expect(parseCedisInput('1000000.01')).toBeNull();
  });

  it('refuses anything that is not a plain non-negative amount of at most two decimals', () => {
    expect(parseCedisInput('')).toBeNull();
    expect(parseCedisInput('abc')).toBeNull();
    expect(parseCedisInput('-5')).toBeNull();
    expect(parseCedisInput('12.345')).toBeNull();
    expect(parseCedisInput('1.')).toBeNull();
    expect(parseCedisInput('.50')).toBeNull();
    expect(parseCedisInput('GHS 12')).toBeNull();
  });
});

describe('pre-filling a Pay card box from stored pesewas', () => {
  it('always shows two decimals', () => {
    expect(pesewasToCedisInput(5)).toBe('0.05');
    expect(pesewasToCedisInput(730)).toBe('7.30');
    expect(pesewasToCedisInput(123_456)).toBe('1234.56');
    expect(pesewasToCedisInput(MAX_MONEY_PESEWAS)).toBe('1000000.00');
  });

  it('round-trips with the parser', () => {
    for (const pesewas of [0, 1, 99, 100, 730, 123_456, MAX_MONEY_PESEWAS]) {
      expect(parseCedisInput(pesewasToCedisInput(pesewas))).toBe(pesewas);
    }
  });
});
