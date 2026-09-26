import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../common/pagination.js';
import { looksLikeAnId, pageBefore } from './payroll-cursor.js';

/** What the caller is actually told when a cursor is refused. */
function refusalFor(cursor: string): unknown {
  try {
    pageBefore(cursor);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
  throw new Error(`The cursor ${cursor} was accepted, and should not have been.`);
}

/** The refusal names the field, so the dashboard can point at it. */
const NAMES_THE_CURSOR = {
  message: [
    { path: ['cursor'], message: 'The cursor is not valid. Start again from the first page.' },
  ],
};

describe('the cursor a payroll list pages by', () => {
  it('gives back the date it holds', () => {
    const date = pageBefore(encodeCursor('2026-09-01'));
    expect(date?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('gives back nothing at all for the first page', () => {
    expect(pageBefore(undefined)).toBeUndefined();
  });

  it('refuses something that is not one of our cursors', () => {
    expect(refusalFor('not-a-cursor!!')).toEqual(NAMES_THE_CURSOR);
    expect(refusalFor('')).toEqual(NAMES_THE_CURSOR);
  });

  it('refuses a cursor that decodes cleanly but holds no date', () => {
    // This is the one that bit. `aGVsbG8` is the word "hello" in base64url, so
    // it survives the round-trip check and looks like a real cursor. It then
    // became an Invalid Date, which the database refuses with an error that
    // carries no HTTP status — so the caller got a 500 for a bad request.
    expect(encodeCursor('hello')).toBe('aGVsbG8');
    expect(refusalFor('aGVsbG8')).toEqual(NAMES_THE_CURSOR);
  });

  it('refuses a full timestamp where a calendar date belongs', () => {
    expect(refusalFor(encodeCursor('2026-09-01T00:00:00.000Z'))).toEqual(NAMES_THE_CURSOR);
  });

  it('refuses a date that does not exist on the calendar', () => {
    // Without this, 30 February would slide quietly into March and the page
    // would start in the wrong month.
    expect(refusalFor(encodeCursor('2026-02-30'))).toEqual(NAMES_THE_CURSOR);
    expect(refusalFor(encodeCursor('2026-13-01'))).toEqual(NAMES_THE_CURSOR);
  });
});

/**
 * A cursor's id half.
 *
 * `decodeCursor` proves only that a value is one of our base64 cursors, not
 * that what comes out means anything. Before this check, the id half reached
 * Prisma as a uuid, which refuses a malformed one with an error carrying no
 * HTTP status — so the caller got a 500 for a plainly bad request.
 */
describe('a cursor id', () => {
  it('accepts a real UUID, in either case', () => {
    expect(looksLikeAnId('01927c3e-5a4b-7c8d-9e0f-1a2b3c4d5e6f')).toBe(true);
    expect(looksLikeAnId('01927C3E-5A4B-7C8D-9E0F-1A2B3C4D5E6F')).toBe(true);
  });

  it('refuses anything that is not one', () => {
    expect(looksLikeAnId(undefined)).toBe(false);
    expect(looksLikeAnId('')).toBe(false);
    // The exact value that used to reach the database and answer 500.
    expect(looksLikeAnId('world')).toBe(false);
    // Right shape, wrong characters.
    expect(looksLikeAnId('zzzzzzzz-5a4b-7c8d-9e0f-1a2b3c4d5e6f')).toBe(false);
    // One digit short, and one too long.
    expect(looksLikeAnId('01927c3e-5a4b-7c8d-9e0f-1a2b3c4d5e6')).toBe(false);
    expect(looksLikeAnId('01927c3e-5a4b-7c8d-9e0f-1a2b3c4d5e6ff')).toBe(false);
    // A SQL fragment, which is the reason this is a pattern and not a length check.
    expect(looksLikeAnId("' OR 1=1 --")).toBe(false);
  });
});
