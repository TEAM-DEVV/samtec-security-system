import { describe, expect, it } from 'vitest';
import { newUuidV7 } from './ids.js';

describe('newUuidV7', () => {
  it('looks like a UUID, and says it is version 7', () => {
    const id = newUuidV7();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('carries the time it was made, so later ids sort after earlier ones', () => {
    const earlier = newUuidV7(new Date('2026-01-01T00:00:00Z').getTime());
    const later = newUuidV7(new Date('2026-09-23T10:30:00Z').getTime());

    expect(earlier < later).toBe(true);
    // The first 12 characters are the millisecond it was made.
    expect(earlier.replace(/-/g, '').slice(0, 12)).toBe(
      new Date('2026-01-01T00:00:00Z').getTime().toString(16).padStart(12, '0'),
    );
  });

  it('never makes the same one twice', () => {
    const now = Date.now();
    const many = new Set(Array.from({ length: 1000 }, () => newUuidV7(now)));

    expect(many.size).toBe(1000);
  });
});
