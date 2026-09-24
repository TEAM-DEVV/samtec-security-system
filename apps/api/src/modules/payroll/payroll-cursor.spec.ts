import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../common/pagination.js';
import { pageBefore } from './payroll-cursor.js';

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
