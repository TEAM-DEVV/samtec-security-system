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

const ACCRA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Accra',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The Ghana (Africa/Accra) calendar date of a moment, as `YYYY-MM-DD`. A
 * night shift's hours belong to the date it started on, so this decides
 * which day a shift counts for. Ghana happens to be UTC+0 all year, but the
 * code asks the time zone database instead of relying on that.
 */
export function toAccraDate(instant: Date): string {
  return ACCRA_DATE.format(instant);
}

/** A `YYYY-MM-DD` date as the midnight-UTC Date that `@db.Date` columns store. */
export function fromIsoDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}
