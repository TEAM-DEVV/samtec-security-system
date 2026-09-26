import { DEVICE_SIGNATURE_VECTOR } from '@samtec/contracts/device-signature-vector';
import { describe, expect, it } from 'vitest';
import { importSigningKey, type KioskRoute, nowInSeconds, signRequest } from './signing';

/**
 * The kiosk's half of the signing scheme.
 *
 * The other half is `apps/api/src/modules/attendance/device-signature.ts`, and
 * `device-signature.spec.ts` beside it asserts the same worked example against
 * Node's crypto. Two implementations, one example: if either drifts, exactly one
 * of the two test files goes red and it names the side that moved.
 *
 * Without that, the failure would be a 401 on every clock-in with nothing to say
 * which side was wrong.
 */
describe('signing a kiosk request', () => {
  const { secret, timestamp, route, body, signature } = DEVICE_SIGNATURE_VECTOR;
  const asRoute = route as KioskRoute;

  it('produces the signature the server expects', async () => {
    const key = await importSigningKey(secret);
    expect(await signRequest(key, timestamp, asRoute, body)).toBe(signature);
  });

  it('gives a different signature for a changed body', async () => {
    const key = await importSigningKey(secret);
    // One character. The server would refuse this, which is the point: the body
    // is signed, so nothing about the request can be altered in transit.
    const changed = body.replace('"IN"', '"OUT"');
    expect(await signRequest(key, timestamp, asRoute, changed)).not.toBe(signature);
  });

  it('gives a different signature on another route', async () => {
    const key = await importSigningKey(secret);
    // Signing the route *name* is what stops a signature being lifted from one
    // endpoint to another. It also means a hosting rewrite can never break one.
    expect(await signRequest(key, timestamp, 'kiosk/confirm', body)).not.toBe(signature);
  });

  it('gives a different signature at another moment', async () => {
    const key = await importSigningKey(secret);
    const later = String(Number(timestamp) + 1);
    expect(await signRequest(key, later, asRoute, body)).not.toBe(signature);
  });

  it('writes a lowercase hex signature of the right length', async () => {
    const key = await importSigningKey(secret);
    const made = await signRequest(key, timestamp, asRoute, body);
    // HMAC-SHA256 is 32 bytes, and the server compares hex.
    expect(made).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the signing key', () => {
  it('cannot be read back out of the browser', async () => {
    const key = await importSigningKey(DEVICE_SIGNATURE_VECTOR.secret);
    expect(key.extractable).toBe(false);
    // This is the whole reason the secret is imported the moment it arrives and
    // never written down: once it is a key, nothing running on this page can ask
    // for the bytes again — not our code, and not anything that gets in later.
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('can sign and nothing else', async () => {
    const key = await importSigningKey(DEVICE_SIGNATURE_VECTOR.secret);
    expect(key.usages).toEqual(['sign']);
  });
});

describe('the timestamp', () => {
  it('is whole Unix seconds, which is what the server checks freshness against', () => {
    expect(nowInSeconds(new Date('2026-09-26T12:00:00.750Z'))).toBe('1790424000');
    // Never a fraction: the server refuses a timestamp that is not an integer.
    expect(nowInSeconds(new Date('2026-09-26T12:00:00.750Z'))).toMatch(/^\d+$/);
  });
});
