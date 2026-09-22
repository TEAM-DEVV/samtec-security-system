import type { ProblemDetails } from '@samtec/contracts';

/** True when a value looks like a Problem Details error body sent by the API. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'title' in value &&
    'traceId' in value
  );
}

/**
 * Turns anything a request can fail with into a message for the user.
 *
 * - A validation error shows its first field problem, which says what to fix.
 * - Any other API error shows its `detail`.
 * - When the API is not running there is no Problem Details body at all, only a
 *   network error, so that case gets its own message.
 */
export function describeApiError(error: unknown): { message: string; traceId?: string } {
  if (isProblemDetails(error)) {
    const firstIssue = error.errors?.[0];
    return { message: firstIssue?.message ?? error.detail ?? error.title, traceId: error.traceId };
  }
  return { message: 'Could not reach the SAMTEC API. Check that it is running, then try again.' };
}

/**
 * True when sending a failed request again might work: the API could not be
 * reached at all, it answered with a server error (500 or higher), or it asked
 * for a pause (429, worth retrying after the wait). A client error such as
 * 400 or 404 would only fail the same way again.
 */
export function isWorthRetrying(error: unknown): boolean {
  if (isProblemDetails(error)) {
    return error.status >= 500 || error.status === 429;
  }
  return true;
}
