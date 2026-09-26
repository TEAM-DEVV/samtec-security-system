/**
 * The cursor every payroll list pages by.
 *
 * All three of them — months, rate versions and pay history — are sorted
 * newest first by a calendar date, so the cursor holds that date and the next
 * page asks for rows before it.
 *
 * It is one function rather than three copies because the mistake it prevents
 * is easy to make and invisible when made. `decodeCursor` only proves a value
 * is one of our base64 cursors, not that what comes out of it means anything:
 * `aGVsbG8` decodes cleanly to `hello`, which then becomes an Invalid Date,
 * which Prisma refuses with an error carrying no HTTP status — so the caller
 * gets a 500 for what is plainly a bad request. Checking the shape of the
 * decoded value is what turns that back into a 400 naming the field.
 */
import { BadRequestException } from '@nestjs/common';
import { fromIsoDate } from '../../common/dates.js';
import { decodeCursor } from '../../common/pagination.js';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The shape of every id in this system: a UUID, in the canonical form Prisma
 * accepts for a `@db.Uuid` column.
 *
 * This is checked rather than assumed because of what happens otherwise.
 * `decodeCursor` proves only that a value is one of our base64 cursors, not
 * that what comes out of it means anything — `aGVsbG8tfHdvcmxk` decodes
 * perfectly well to `hello|world`. The `world` half then reaches Prisma as a
 * uuid, which it refuses with an error that carries no HTTP status, so the
 * caller gets a 500 for a plainly bad request.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a cursor's id half is really an id. */
export function looksLikeAnId(value: string | undefined): value is string {
  return value !== undefined && UUID.test(value);
}

/**
 * The date a cursor points just past, or `undefined` when there is no cursor.
 * Anything that is not one of our cursors, or that does not hold a real
 * calendar date, is a 400 that tells the caller to start again.
 */
export function pageBefore(cursor: string | undefined): Date | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  const value = decodeCursor(cursor);
  if (value === undefined || !CALENDAR_DATE.test(value)) {
    throw badCursor();
  }

  const date = fromIsoDate(value);
  // Catches a date that passes the pattern but does not exist, such as
  // 2026-02-30, which would otherwise reach the database as a silent shift
  // into March.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw badCursor();
  }
  return date;
}

/** The one refusal every payroll list gives for a cursor it cannot use. */
export function badCursor(): BadRequestException {
  return new BadRequestException({
    message: [
      { path: ['cursor'], message: 'The cursor is not valid. Start again from the first page.' },
    ],
  });
}
