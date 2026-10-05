/**
 * Showing a bank account or mobile money number without ever showing all of
 * it: the company's own bank account (`GET /company/bank-account`) and the
 * payment receipt (`payroll-approval.service.ts`) both need to point at an
 * account on a screen or a page without printing it in full.
 *
 * A fixed four stars stand in for whatever came before, on purpose. Masking
 * one star per hidden digit would still leak the account number's length,
 * which is itself worth keeping back — the same reasoning decision 25 in
 * docs/plan/09-payroll-engine-ghana.md uses to explain why even a hash of an
 * account number is too much to keep in a log that can never be edited.
 */

/** The last four characters of a value, for example an account number. */
export function lastFour(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

/**
 * `"1234567890123"` becomes `"**** 0123"`. Never the full number, and never
 * more than its last four digits.
 */
export function maskToLastFour(value: string): string {
  return `**** ${lastFour(value)}`;
}

/** The same, but passes `null` through, for a field that may be unset. */
export function maskToLastFourOrNull(value: string | null): string | null {
  return value === null ? null : maskToLastFour(value);
}
