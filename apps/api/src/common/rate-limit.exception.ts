import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A 429 "Too Many Requests" error that also tells the caller how long to
 * wait. `ProblemDetailsFilter` turns `retryAfterSeconds` into the standard
 * `Retry-After` response header, as the contract promises.
 */
export class RateLimitException extends HttpException {
  constructor(
    detail: string,
    readonly retryAfterSeconds: number,
    /**
     * True only on the attempt that started this lockout, so whoever catches
     * it can write one audit line instead of one per attempt while locked.
     */
    readonly justLocked = false,
  ) {
    super(detail, HttpStatus.TOO_MANY_REQUESTS);
  }
}
