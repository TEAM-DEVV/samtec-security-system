/**
 * How this kiosk proves a request came from it.
 *
 * The one definition on the server is
 * `apps/api/src/modules/attendance/device-signature.ts`. This file must agree
 * with it exactly, and `signing.test.ts` pins them together with a fixed
 * example: a known secret, timestamp, route and body, and the signature they
 * must produce. The same example is checked on the API side, so the two
 * implementations cannot drift apart without a test going red.
 *
 * The signed bytes are `v1\n<timestamp>\n<route>\n<body>`, where `<route>` is
 * the route *name* (`kiosk/identify`), never the URL — so a hosting rewrite can
 * never break a signature, and a signature can never be moved to another
 * endpoint.
 */

/** The routes a kiosk may call. The server has the full list, including the terminal routes. */
export type KioskRoute =
  | 'ingest/heartbeat'
  | 'kiosk/consents'
  | 'kiosk/face-enrollments'
  | 'kiosk/identify'
  | 'kiosk/confirm'
  | 'kiosk/not-me'
  | 'kiosk/assisted-punches'
  | 'kiosk/passkey-options'
  | 'kiosk/passkeys'
  | 'kiosk/fingerprint-options';

/**
 * Turns the device secret into a signing key the rest of the app cannot read.
 *
 * `extractable: false` is the point of this function. The key object can be
 * stored in IndexedDB and used to sign, but no code — ours, or anything that
 * later manages to run on this page — can ask the browser for the secret back.
 * So the secret exists in readable form for exactly as long as it takes to get
 * here, and never again.
 */
export async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Unix seconds, as the server's freshness check expects. */
export function nowInSeconds(at: Date = new Date()): string {
  return String(Math.floor(at.getTime() / 1000));
}

/**
 * The signature for one request: lowercase hex HMAC-SHA256.
 *
 * `body` is the **exact text that will be sent**. Serialise once, sign that
 * string, send that string — re-serialising would change a space somewhere and
 * the server would refuse everything.
 */
export async function signRequest(
  key: CryptoKey,
  timestamp: string,
  route: KioskRoute,
  body: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`v1\n${timestamp}\n${route}\n${body}`);
  const signature = await crypto.subtle.sign('HMAC', key, bytes);
  return hex(new Uint8Array(signature));
}

/** Bytes as lowercase hex, which is the format the server compares. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
