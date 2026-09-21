import { randomBytes } from 'node:crypto';
import { deriveKey } from '../identity/secret-box.js';

/**
 * Where device secrets come from and which key locks them. One place, so the
 * API, the seed and the demo simulator can never disagree.
 */

/** 32 random bytes, base64url (43 characters): far too many to guess. */
export function newDeviceSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The key that encrypts device secrets at rest, derived from AUTH_SECRET for
 * this purpose only. Rotating AUTH_SECRET makes every stored device secret
 * unreadable, so every device must then get a new one.
 */
export function deviceSecretKey(authSecret: string): Buffer {
  return deriveKey(authSecret, 'device-secret');
}
