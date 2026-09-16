import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept a caller's request ID only when it looks harmless, so nobody can
// inject fake log lines or huge values through this header.
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Gives every request an ID, returns it in the `X-Request-ID` response header,
 * and keeps it for error responses (`traceId`) and logs. When a user reports a
 * problem, this ID leads straight to the matching log lines.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.header(REQUEST_ID_HEADER);
  const requestId =
    incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  response.locals.requestId = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

/** Reads the ID set by `requestIdMiddleware`, or creates one if it is missing. */
export function getRequestId(response: Response): string {
  const value: unknown = response.locals.requestId;
  return typeof value === 'string' ? value : randomUUID();
}
