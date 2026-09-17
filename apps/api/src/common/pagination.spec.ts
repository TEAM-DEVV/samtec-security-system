import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, toPage } from './pagination.js';

describe('cursors', () => {
  it('round-trips a sort value', () => {
    expect(decodeCursor(encodeCursor('SMT-00042'))).toBe('SMT-00042');
  });

  it('rejects values that are not our cursors', () => {
    expect(decodeCursor('not base64url!!')).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
    expect(decodeCursor('x'.repeat(201))).toBeUndefined();
  });
});

describe('toPage', () => {
  const sortValueOf = (row: { staffNumber: string }) => row.staffNumber;
  const rows = [
    { staffNumber: 'SMT-00001' },
    { staffNumber: 'SMT-00002' },
    { staffNumber: 'SMT-00003' },
  ];

  it('keeps `limit` rows and points the cursor at the last one', () => {
    const { pageRows, nextCursor } = toPage(rows, 2, sortValueOf);

    expect(pageRows.map(sortValueOf)).toEqual(['SMT-00001', 'SMT-00002']);
    expect(nextCursor).toBe(encodeCursor('SMT-00002'));
  });

  it('has no next cursor on the last page', () => {
    expect(toPage(rows, 3, sortValueOf).nextCursor).toBeNull();
    expect(toPage([], 3, sortValueOf).nextCursor).toBeNull();
  });
});
