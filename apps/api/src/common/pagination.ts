/**
 * Cursor pagination, as the contract describes: each page returns a
 * `nextCursor`, and sending it back as `cursor` continues from that point.
 *
 * A cursor is simply the sort value of the last row on the page (for example
 * a staff number), base64-encoded so it looks opaque and survives URLs. The
 * next page then asks the database for rows *after* that value, which stays
 * fast no matter how deep the caller pages.
 */

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
