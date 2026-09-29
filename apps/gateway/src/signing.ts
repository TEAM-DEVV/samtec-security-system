/**
 * Signing a request to the API, exactly as every device does:
 * `HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`, lowercase hex.
 *
 * This is the third implementation of the one scheme (the API checks with
 * Node's crypto, the kiosk signs with WebCrypto), so it asserts the same
 * shared worked example the other two assert
 * (`packages/contracts/src/device-signature-vector.ts`). If any of the three
 * drifts, exactly one test goes red and it names the side that moved.
 */
import { createHmac } from 'node:crypto';

/** The routes a ZKTECO device may sign (`kindMayUse` on the API). */
export type GatewayRoute =
  | 'ingest/punches'
  | 'ingest/heartbeat'
  | 'ingest/roster'
  | 'ingest/enrollments';

export function nowInSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * The body must be the exact text that is sent: serialise once, sign that
 * string, send that string. Serialising twice puts a different space somewhere
 * and the server refuses everything with a 401 that says nothing about why.
 */
export function signRequest(
  secret: string,
  timestamp: string,
  route: GatewayRoute,
  bodyText: string,
): string {
  return createHmac('sha256', secret)
    .update(`v1\n${timestamp}\n${route}\n${bodyText}`)
    .digest('hex');
}
