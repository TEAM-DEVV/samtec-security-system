/**
 * Cursor pagination, as the contract describes: each page returns a
 * `nextCursor`, and sending it back as `cursor` continues from that point.
 *
 * A cursor is simply the sort value of the last row on the page (for example
 * a staff number), base64-encoded so it looks opaque and survives URLs. The
 * next page then asks the database for rows *after* that value, which stays
 * fast no matter how deep the caller pages.
 */

import { BadRequestException } from '@nestjs/common';

const MAX_CURSOR_LENGTH = 200;

/** Turns the last row's sort value into the cursor for the next page. */
export function encodeCursor(sortValue: string): string {
  return Buffer.from(sortValue, 'utf8').toString('base64url');
}

/**
 * Turns a cursor back into the sort value it holds. Returns undefined for
 * anything that is not one of our cursors, so a made-up value becomes a clear
 * 400 error instead of a strange page.
 */
export function decodeCursor(cursor: string): string | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return undefined;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // Round-tripping proves the input really was base64url, because Buffer
  // silently ignores characters it cannot place.
  if (encodeCursor(decoded) !== cursor) {
    return undefined;
  }
  return decoded;
}

/** The shape every id in this database has: a UUID, written out in full. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a full UUID, and false for anything else — including free text. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * The id a cursor points at, for every list sorted by id, or `undefined` when
 * there is no cursor.
 *
 * `decodeCursor` only proves a value is one of our base64 cursors, never that
 * what came out of it means anything: `aGVsbG8` decodes cleanly to `hello`,
 * which then reaches a uuid column, and Prisma refuses it with an error that
 * carries no HTTP status — so the caller got a 500 for what was plainly a bad
 * request. Checking the shape here is what turns that back into a 400 naming
 * the field. Payroll's lists page by a calendar date instead and keep their
 * own check in `payroll-cursor.ts`.
 */
export function uuidCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const value = decodeCursor(cursor);
  if (value === undefined || !isUuid(value)) {
    throw new BadRequestException({
      message: [
        { path: ['cursor'], message: 'The cursor is not valid. Start again from the first page.' },
      ],
    });
  }
  return value;
}

/**
 * Builds one page from `limit + 1` rows: the extra row only tells us whether
 * a next page exists. `sortValueOf` names the value the rows are sorted by.
 */
export function toPage<Row>(
  rows: Row[],
  limit: number,
  sortValueOf: (row: Row) => string,
): { pageRows: Row[]; nextCursor: string | null } {
  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > limit && lastRow ? encodeCursor(sortValueOf(lastRow)) : null;
  return { pageRows, nextCursor };
}
