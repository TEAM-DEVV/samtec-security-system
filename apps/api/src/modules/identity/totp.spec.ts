import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotpCode,
} from './totp.js';

/** The shared secret every RFC 6238 test vector uses: the ASCII text below. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('encodes the RFC secret the way authenticator apps expect', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('rejects text that is not base32', () => {
    expect(() => base32Decode('not base32!')).toThrow();
  });
});

describe('totpCode', () => {
  // The official RFC 6238 (Appendix B) test vectors, SHA-1, 8 digits.
  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ])('matches the RFC 6238 test vector at %d seconds', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(expected);
  });

  it('produces 6 digits by default, like authenticator apps', () => {
    expect(totpCode(RFC_SECRET, totpStep(59_000))).toBe('287082');
  });
});

describe('verifyTotpCode', () => {
  const at = 1_111_111_109_000; // A fixed moment, so the tests never flake.
  const step = totpStep(at);

  it('accepts the current code and reports its step', () => {
    expect(verifyTotpCode(RFC_SECRET, totpCode(RFC_SECRET, step), at)).toBe(step);
  });

  it('tolerates one step of clock difference either way', () => {
    expect(verifyTotpCode(RFC_SECRET, totpCode(RFC_SECRET, step - 1), at)).toBe(step - 1);
    expect(verifyTotpCode(RFC_SECRET, totpCode(RFC_SECRET, step + 1), at)).toBe(step + 1);
  });

  it('rejects a code from further away than one step', () => {
    expect(verifyTotpCode(RFC_SECRET, totpCode(RFC_SECRET, step - 2), at)).toBeNull();
    expect(verifyTotpCode(RFC_SECRET, totpCode(RFC_SECRET, step + 5), at)).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    expect(verifyTotpCode(RFC_SECRET, '000000', at)).toBeNull();
    expect(verifyTotpCode(RFC_SECRET, 'abcdef', at)).toBeNull();
    expect(verifyTotpCode(RFC_SECRET, '12345', at)).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('builds the link authenticator apps scan', () => {
    expect(otpauthUri('ama@samtec.example', 'ABC234')).toBe(
      'otpauth://totp/SAMTEC:ama%40samtec.example?secret=ABC234&issuer=SAMTEC&algorithm=SHA1&digits=6&period=30',
    );
  });
});
