/**
 * One worked example of a signed device request, shared by both sides.
 *
 * The kiosk signs with the browser's WebCrypto and the API checks with Node's
 * crypto. Those are two separate implementations of the same scheme, and the
 * failure they invite is silent: a stray newline or a re-serialised body and
 * every clock-in is refused, with nothing to say which side is wrong.
 *
 * So both sides assert this example. `apps/kiosk/src/lib/signing.test.ts`
 * checks the kiosk produces `signature`, and
 * `apps/api/src/modules/attendance/device-signature.spec.ts` checks the server
 * does too. If either implementation drifts, exactly one test goes red and it
 * names the side that moved.
 *
 * The secret is fictional and belongs to no device. Never use it anywhere.
 */
export const DEVICE_SIGNATURE_VECTOR = {
  secret: 'sk_test_kiosk_shared_vector_do_not_use_in_production',
  /** Unix seconds. Fixed, so the example never depends on the clock. */
  timestamp: '1790000000',
  route: 'kiosk/identify',
  /**
   * The exact text that is signed and sent. Not an object: the bytes are what
   * is signed, so the example has to pin the bytes.
   */
  body: '{"purpose":"CLOCK","direction":"IN"}',
  /** Lowercase hex HMAC-SHA256 over `v1\n<timestamp>\n<route>\n<body>`. */
  signature: '03ffecc962612dd6db29a1f0130b121b856e25d5dd7823127a9f8b71a3d2f5e0',
} as const;
