import type { ProblemDetails } from '@samtec/contracts';
import { isProblemDetails } from './problem';

/**
 * The password step before a sensitive action (docs/plan/06, "One
 * administrator, with a password"). When the API refuses a request with
 * `403` and `code: PASSWORD_CONFIRMATION_REQUIRED`, the API client asks the
 * one "Confirm with your password" dialog to take the step, then sends the
 * request again. One confirmation covers five minutes, so a person is asked
 * once, not at every click.
 */

/** True for the API's answer to a sensitive action taken without a fresh password confirmation. */
export function isPasswordConfirmationRequired(value: unknown): value is ProblemDetails {
  return (
    isProblemDetails(value) &&
    value.status === 403 &&
    value.code === 'PASSWORD_CONFIRMATION_REQUIRED'
  );
}

/**
 * Opens the dialog and settles when the person has confirmed (true: the new
 * access token is already in the session) or given up (false).
 */
type Asker = () => Promise<boolean>;

let asker: Asker | null = null;
let inFlight: Promise<boolean> | null = null;

/** The dialog registers itself here when it mounts, and unregisters when it unmounts. */
export function setPasswordConfirmationAsker(next: Asker | null): void {
  asker = next;
}

/**
 * Asks the person for their password. Requests refused at the same moment
 * share one dialog, so a page that fired three sensitive calls together asks
 * once. Without a dialog on the page (for example a plain script), nobody
 * can answer, and the request stays refused.
 */
export function askForPasswordConfirmation(): Promise<boolean> {
  if (asker === null) {
    return Promise.resolve(false);
  }
  inFlight ??= asker().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
