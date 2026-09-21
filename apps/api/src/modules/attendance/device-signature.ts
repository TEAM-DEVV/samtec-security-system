import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The one definition of how a device signs a request. The guard that checks
 * signatures, the device simulator and the tests all use these functions, so
 * the scheme cannot drift between them. Contract: the `deviceSignature`
 * security scheme.
 */

/** The only two routes a device may call. Signing the route name (not the URL) means hosting rewrites can never break a signature, and a signature can never be moved to the other endpoint. */
export type SignedRoute = 'ingest/punches' | 'ingest/heartbeat';

/** A timestamp more than 5 minutes from the server clock is refused. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

/** The exact bytes that are signed: `v1\n<timestamp>\n<route>\n<body>`. */
function signingBytes(timestamp: string, route: SignedRoute, rawBody: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`v1\n${timestamp}\n${route}\n`, 'utf8'),
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody,
  ]);
}

/** The signature for a request: lowercase hex HMAC-SHA256 with the device's secret. */
export function signRequest(
  secret: string,
  timestamp: string,
  route: SignedRoute,
  rawBody: Buffer | string,
): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(signingBytes(timestamp, route, rawBody))
    .digest('hex');
}

/**
 * True when `signature` is right. The comparison takes the same time however
 * many characters match, so timing cannot reveal the right signature.
 */
export function signatureMatches(
  secret: string,
  timestamp: string,
  route: SignedRoute,
  rawBody: Buffer | string,
  signature: string,
): boolean {
  const expected = Buffer.from(signRequest(secret, timestamp, route, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** True when a Unix-seconds timestamp is within 5 minutes of `now`. */
export function timestampIsFresh(timestamp: string, now: Date): boolean {
  const seconds = Number(timestamp);
  return (
    Number.isInteger(seconds) && Math.abs(now.getTime() / 1000 - seconds) <= MAX_CLOCK_SKEW_SECONDS
  );
}
