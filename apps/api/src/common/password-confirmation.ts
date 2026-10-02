import { ForbiddenException } from '@nestjs/common';
import type { ProblemDetails } from '@samtec/contracts';
import type { SignedInUser } from './auth.decorators.js';

/**
 * A password confirmation covers five minutes of work: an administrator who
 * confirms once is not asked again at every click (docs/plan/06, "One
 * administrator, with a password").
 */
export const PASSWORD_CONFIRMATION_SECONDS = 5 * 60;

/** The `code` a sensitive route answers with when the confirmation is missing or old. */
export const PASSWORD_CONFIRMATION_REQUIRED =
  'PASSWORD_CONFIRMATION_REQUIRED' satisfies NonNullable<ProblemDetails['code']>;

/** True while the caller's last password confirmation is under five minutes old. */
export function hasFreshPasswordConfirmation(
  user: Pick<SignedInUser, 'passwordConfirmedAt'>,
  now: Date = new Date(),
): boolean {
  if (user.passwordConfirmedAt === null) {
    return false;
  }
  const ageMilliseconds = now.getTime() - user.passwordConfirmedAt.getTime();
  return ageMilliseconds >= 0 && ageMilliseconds <= PASSWORD_CONFIRMATION_SECONDS * 1000;
}

/**
 * A 403 with a machine-readable `code`, so the dashboard knows to open its
 * "Confirm with your password" dialog and then send the request again. The
 * `ProblemDetailsFilter` copies the code into the response body.
 */
export class PasswordConfirmationRequiredException extends ForbiddenException {
  readonly code = PASSWORD_CONFIRMATION_REQUIRED;

  constructor() {
    super('Confirm with your password to continue.');
  }
}
