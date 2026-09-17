/**
 * Encrypts small secrets (authenticator secrets) before they are stored in
 * the database, with AES-256-GCM from Node's built-in crypto. GCM both hides
 * the value and detects tampering: a modified stored value fails to decrypt
 * instead of quietly decrypting to something else.
 *
 * Stored format: `v1$<iv>$<auth tag>$<ciphertext>`, each part base64.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Derives a fixed-size key from the AUTH_SECRET for one purpose, using HKDF
 * (a standard key-derivation function). Different purposes ("access-token",
 * "secret-box") get unrelated keys from the same master secret, so one master
 * secret in `.env` is enough.
 */
export function deriveKey(masterSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterSecret, 'samtec-v1', purpose, KEY_BYTES));
}

/** Encrypts a small text secret for storage. */
export function sealSecret(plainText: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('$');
}

/** Decrypts a stored secret. Returns null when the value is damaged or was tampered with. */
export function openSecret(sealed: string, key: Buffer): string | null {
  const parts = sealed.split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1] ?? '', 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2] ?? '', 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3] ?? '', 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
