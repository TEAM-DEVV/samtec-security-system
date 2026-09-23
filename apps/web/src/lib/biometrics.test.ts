import { describe, expect, it } from 'vitest';
import {
  formatSimilarity,
  isAttemptOutcome,
  isCollisionStatus,
  isWorryingOutcome,
} from './biometrics';

describe('formatSimilarity', () => {
  it('rounds the score to whole percent', () => {
    expect(formatSimilarity(0.71)).toBe('71% alike');
    expect(formatSimilarity(0.625)).toBe('63% alike');
    expect(formatSimilarity(1)).toBe('100% alike');
  });
});

describe('isWorryingOutcome', () => {
  it('leaves a clean match and the normal fingerprint step alone', () => {
    expect(isWorryingOutcome('MATCHED')).toBe(false);
    expect(isWorryingOutcome('FINGERPRINT_REQUESTED')).toBe(false);
  });

  it('flags every failure and a cancelled match', () => {
    expect(isWorryingOutcome('NOT_RECOGNISED')).toBe(true);
    expect(isWorryingOutcome('LOW_LIVENESS')).toBe(true);
    expect(isWorryingOutcome('NOT_ME')).toBe(true);
    expect(isWorryingOutcome('FALLBACK_REFUSED')).toBe(true);
  });
});

describe('the type guards', () => {
  it('accept only the contract values', () => {
    expect(isAttemptOutcome('MATCHED')).toBe(true);
    expect(isAttemptOutcome('nope')).toBe(false);
    expect(isCollisionStatus('RESOLVED')).toBe(true);
    expect(isCollisionStatus('')).toBe(false);
  });
});
