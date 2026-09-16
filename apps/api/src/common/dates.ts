/**
 * Turns a database calendar date into the contract's `YYYY-MM-DD` format.
 *
 * Prisma returns `@db.Date` columns (such as `hireDate`) as a JavaScript Date at
 * midnight UTC. Use this helper for those columns, never `toISOString()`, which
 * returns a full timestamp like `2026-09-15T00:00:00.000Z` that the dashboard rejects.
 */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
