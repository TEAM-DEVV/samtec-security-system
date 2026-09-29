import { describe, expect, it, vi } from 'vitest';
import {
  createPasskey,
  FingerprintRefused,
  fromBase64Url,
  getAssertion,
  toBase64Url,
} from './passkeys';

/**
 * The one real job this file has is the encoding: the server speaks base64url
 * strings, the browser speaks buffers, and a single wrong character fails every
 * fingerprint with an error that names nothing. So the translation is pinned
 * here, against values worked out by hand.
 */
describe('base64url', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(new ArrayBuffer(256));
    for (let i = 0; i < 256; i += 1) {
      bytes[i] = i;
    }
    expect(fromBase64Url(toBase64Url(bytes.buffer))).toEqual(bytes);
  });

  it('speaks WebAuthn base64url, not plain base64: -, _ and no padding', () => {
    // 0xfb 0xef 0xbe is "++++" in plain base64; WebAuthn writes it "----".
    expect(toBase64Url(Uint8Array.from([0xfb, 0xef, 0xbe]).buffer)).toBe('----');
    expect(Array.from(fromBase64Url('----'))).toEqual([0xfb, 0xef, 0xbe]);
    // One byte encodes to two characters and no '=' padding.
    expect(toBase64Url(Uint8Array.from([0]).buffer)).toBe('AA');
    expect(Array.from(fromBase64Url('AA'))).toEqual([0]);
  });
});

/** A pretend sensor: enough of `PublicKeyCredential` for the calls to run. */
function aSensorAnswering(credential: unknown) {
  class PretendPublicKeyCredential {}
  Object.setPrototypeOf(credential, PretendPublicKeyCredential.prototype);
  vi.stubGlobal('PublicKeyCredential', PretendPublicKeyCredential);
  const get = vi.fn().mockResolvedValue(credential);
  const create = vi.fn().mockResolvedValue(credential);
  vi.stubGlobal('navigator', { credentials: { get, create } });
  return { get, create };
}

function aCredential(response: Record<string, unknown>) {
  return {
    id: 'key-1',
    rawId: Uint8Array.from([1, 2, 3]).buffer,
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response,
  };
}

describe('getAssertion', () => {
  it('decodes the challenge for the sensor and encodes its answer for the server', async () => {
    const { get } = aSensorAnswering(
      aCredential({
        clientDataJSON: Uint8Array.from([10]).buffer,
        authenticatorData: Uint8Array.from([11]).buffer,
        signature: Uint8Array.from([12]).buffer,
        userHandle: null,
      }),
    );

    const assertion = await getAssertion({
      challenge: toBase64Url(Uint8Array.from([9, 9]).buffer),
      allowCredentials: [{ id: toBase64Url(Uint8Array.from([7]).buffer), type: 'public-key' }],
      userVerification: 'required',
    });

    const asked = get.mock.calls[0]?.[0].publicKey;
    expect(Array.from(asked.challenge)).toEqual([9, 9]);
    expect(Array.from(asked.allowCredentials[0].id)).toEqual([7]);
    expect(asked.userVerification).toBe('required');

    expect(assertion.type).toBe('public-key');
    expect(assertion.rawId).toBe(toBase64Url(Uint8Array.from([1, 2, 3]).buffer));
    expect(assertion.response.signature).toBe(toBase64Url(Uint8Array.from([12]).buffer));
    expect(assertion.response.userHandle).toBeNull();
    vi.unstubAllGlobals();
  });

  it('turns a cancelled sensor into a retryable refusal in plain words', async () => {
    aSensorAnswering(aCredential({}));
    vi.stubGlobal('navigator', {
      credentials: {
        get: vi.fn().mockRejectedValue(new DOMException('cancelled', 'NotAllowedError')),
      },
    });
    await expect(getAssertion({ challenge: 'AA' })).rejects.toMatchObject({
      name: 'FingerprintRefused',
      cancelled: true,
    });
    vi.unstubAllGlobals();
  });

  it('says plainly when this phone has no sensor API at all', async () => {
    vi.stubGlobal('navigator', {});
    // No PublicKeyCredential either.
    const held = globalThis.PublicKeyCredential;
    // @ts-expect-error deliberately removing it for the test
    delete globalThis.PublicKeyCredential;
    await expect(getAssertion({ challenge: 'AA' })).rejects.toBeInstanceOf(FingerprintRefused);
    if (held !== undefined) {
      globalThis.PublicKeyCredential = held;
    }
    vi.unstubAllGlobals();
  });
});

describe('createPasskey', () => {
  it('decodes the user id for the sensor and encodes the attestation back', async () => {
    const { create } = aSensorAnswering(
      aCredential({
        clientDataJSON: Uint8Array.from([20]).buffer,
        attestationObject: Uint8Array.from([21]).buffer,
        getTransports: () => ['internal'],
      }),
    );

    const registration = await createPasskey({
      challenge: toBase64Url(Uint8Array.from([5]).buffer),
      rp: { name: 'SAMTEC' },
      user: {
        id: toBase64Url(Uint8Array.from([6]).buffer),
        name: 'SMT-00042',
        displayName: 'SMT-00042',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    });

    const asked = create.mock.calls[0]?.[0].publicKey;
    expect(Array.from(asked.user.id)).toEqual([6]);
    expect(registration.response.transports).toEqual(['internal']);
    expect(registration.response.attestationObject).toBe(toBase64Url(Uint8Array.from([21]).buffer));
    vi.unstubAllGlobals();
  });
});
