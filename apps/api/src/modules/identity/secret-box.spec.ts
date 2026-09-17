import { describe, expect, it } from 'vitest';
import { deriveKey, openSecret, sealSecret } from './secret-box.js';

const key = deriveKey('a-test-master-secret-of-decent-length!!', 'secret-box');

describe('secret box', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ', key);

    expect(sealed).not.toContain('GEZDGNBVGY3TQOJQ');
    expect(openSecret(sealed, key)).toBe('GEZDGNBVGY3TQOJQ');
  });

  it('encrypts the same secret differently every time', () => {
    expect(sealSecret('same', key)).not.toBe(sealSecret('same', key));
  });

  it('refuses a tampered value instead of decrypting it wrongly', () => {
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ', key);
    const parts = sealed.split('$');
    // Flip one character of the ciphertext.
    const lastPart = parts[3] ?? '';
    parts[3] = (lastPart.startsWith('A') ? 'B' : 'A') + lastPart.slice(1);

    expect(openSecret(parts.join('$'), key)).toBeNull();
    expect(openSecret('not-sealed-at-all', key)).toBeNull();
  });

  it('derives unrelated keys for different purposes from one master secret', () => {
    const otherKey = deriveKey('a-test-master-secret-of-decent-length!!', 'access-token');

    expect(otherKey.equals(key)).toBe(false);
    expect(openSecret(sealSecret('secret', key), otherKey)).toBeNull();
  });
});
