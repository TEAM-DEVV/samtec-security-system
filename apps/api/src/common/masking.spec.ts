import { describe, expect, it } from 'vitest';
import { lastFour, maskToLastFour, maskToLastFourOrNull } from './masking.js';

describe('masking an account number to its last four digits', () => {
  it('keeps only the last four characters, and never the rest', () => {
    expect(lastFour('1234567890123')).toBe('0123');
    expect(maskToLastFour('1234567890123')).toBe('**** 0123');
  });

  it('works for a mobile money number too', () => {
    expect(maskToLastFour('+233241234567')).toBe('**** 4567');
  });

  it('does not grow extra stars for a short value: the length is not hidden', () => {
    expect(lastFour('123')).toBe('123');
    expect(maskToLastFour('123')).toBe('**** 123');
  });

  it('passes null through unmasked, for a value nobody has set yet', () => {
    expect(maskToLastFourOrNull(null)).toBeNull();
    expect(maskToLastFourOrNull('1234567890123')).toBe('**** 0123');
  });
});
