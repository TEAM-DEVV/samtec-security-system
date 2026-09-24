import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESENCE_TOLERANCE_MINUTES, paidBeyondPresence } from './paid-beyond-presence.js';

describe('paid beyond presence (R3)', () => {
  it('says nothing when the shifts cover the pay', () => {
    expect(paidBeyondPresence(9600, 9600, 60)).toBe(0);
    expect(paidBeyondPresence(9600, 12000, 60)).toBe(0);
  });

  it('forgives the tolerance, and only the tolerance', () => {
    // An hour over is a rounded shift; an hour and a minute is a question.
    expect(paidBeyondPresence(9660, 9600, 60)).toBe(0);
    expect(paidBeyondPresence(9661, 9600, 60)).toBe(1);
  });

  it('returns what is past the tolerance, not the whole difference', () => {
    // Paid a full extra eight-hour day: 480 over, 420 of it unexplained.
    expect(paidBeyondPresence(10080, 9600, 60)).toBe(420);
  });

  it('starts at an hour when nobody has tuned it', () => {
    expect(DEFAULT_PRESENCE_TOLERANCE_MINUTES).toBe(60);
    expect(paidBeyondPresence(9660, 9600)).toBe(0);
  });

  it('is at its loudest for somebody paid for a month they never appeared in', () => {
    expect(paidBeyondPresence(9600, 0, 60)).toBe(9540);
  });
});
