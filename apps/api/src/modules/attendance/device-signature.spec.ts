import { DEVICE_SIGNATURE_VECTOR } from '@samtec/contracts/device-signature-vector';
import { describe, expect, it } from 'vitest';
import {
  kindMayUse,
  type SignedRoute,
  signatureMatches,
  signRequest,
  timestampIsFresh,
} from './device-signature.js';

/**
 * How a device proves a request came from it
 * (docs/plan/13-biometrics-design.md section 8).
 */
describe('device signatures', () => {
  /**
   * The worked example both sides check.
   *
   * The kiosk signs with the browser's WebCrypto; this file checks Node's. They
   * are two implementations of one scheme, and the failure they invite is
   * silent: a stray newline, or a body serialised twice, and every clock-in is
   * refused with nothing to say which side is wrong.
   * `apps/kiosk/src/lib/signing.test.ts` asserts this same example, so if
   * either side drifts, exactly one test goes red and it names the side that
   * moved.
   */
  it('signs the example shared with the kiosk to the recorded signature', () => {
    const { secret, timestamp, route, body, signature } = DEVICE_SIGNATURE_VECTOR;
    expect(signRequest(secret, timestamp, route as SignedRoute, body)).toBe(signature);
  });

  it('accepts its own signature and refuses a changed body', () => {
    const { secret, timestamp, route, body, signature } = DEVICE_SIGNATURE_VECTOR;
    const asRoute = route as SignedRoute;
    expect(signatureMatches(secret, timestamp, asRoute, body, signature)).toBe(true);
    // One character of the body, and nothing matches any more.
    const changed = body.replace('"IN"', '"OUT"');
    expect(signatureMatches(secret, timestamp, asRoute, changed, signature)).toBe(false);
  });

  it('will not let a signature be moved to another route', () => {
    const { secret, timestamp, body, signature } = DEVICE_SIGNATURE_VECTOR;
    // Signing the route *name* is what makes this impossible: the same body
    // signed for `kiosk/identify` is worthless on `kiosk/confirm`.
    expect(signatureMatches(secret, timestamp, 'kiosk/confirm', body, signature)).toBe(false);
  });

  it('refuses a signature of the wrong length without throwing', () => {
    const { secret, timestamp, route, body } = DEVICE_SIGNATURE_VECTOR;
    expect(signatureMatches(secret, timestamp, route as SignedRoute, body, 'abcd')).toBe(false);
    expect(signatureMatches(secret, timestamp, route as SignedRoute, body, '')).toBe(false);
  });

  describe('the clock', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const secondsAt = (offset: number) => String(Math.floor(now.getTime() / 1000) + offset);

    it('allows five minutes of drift either way', () => {
      expect(timestampIsFresh(secondsAt(0), now)).toBe(true);
      expect(timestampIsFresh(secondsAt(299), now)).toBe(true);
      expect(timestampIsFresh(secondsAt(-299), now)).toBe(true);
    });

    it('refuses anything further off, or not a whole number of seconds', () => {
      expect(timestampIsFresh(secondsAt(301), now)).toBe(false);
      expect(timestampIsFresh(secondsAt(-301), now)).toBe(false);
      expect(timestampIsFresh('not-a-number', now)).toBe(false);
      expect(timestampIsFresh('1790000000.5', now)).toBe(false);
    });
  });

  describe('which device may call which route', () => {
    it('never lets a kiosk post raw punches', () => {
      // A kiosk's punches are made by the server from a face match, so a
      // stolen kiosk key cannot invent attendance (docs/plan/13 section 3).
      expect(kindMayUse('ingest/punches', 'FACE_KIOSK', false)).toBe(false);
    });

    it('keeps the kiosk routes to kiosks', () => {
      expect(kindMayUse('kiosk/identify', 'FACE_KIOSK', false)).toBe(true);
      expect(kindMayUse('kiosk/identify', 'ZKTECO', false)).toBe(false);
      expect(kindMayUse('kiosk/identify', 'MOCK', true)).toBe(false);
    });

    it('only trusts the simulator where it is switched on', () => {
      expect(kindMayUse('ingest/punches', 'MOCK', true)).toBe(true);
      expect(kindMayUse('ingest/punches', 'MOCK', false)).toBe(false);
    });

    it('takes a heartbeat from anything', () => {
      expect(kindMayUse('ingest/heartbeat', 'MOCK', false)).toBe(true);
      expect(kindMayUse('ingest/heartbeat', 'ZKTECO', false)).toBe(true);
      expect(kindMayUse('ingest/heartbeat', 'FACE_KIOSK', false)).toBe(true);
    });
  });
});
