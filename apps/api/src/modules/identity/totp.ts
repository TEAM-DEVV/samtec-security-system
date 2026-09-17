/**
 * Time-based one-time passwords (TOTP): the 6-digit codes an authenticator
 * app shows. Implemented directly from the standards, RFC 6238 (TOTP) and
 * RFC 4226 (HOTP), using only Node's built-in crypto. The test file proves
 * this implementation against the official RFC test vectors.
 *
 * How it works, in one breath: the server and the app share a secret. Both
 * turn the current time into a step number (one step per 30 seconds), mix the
 * step with the secret using HMAC, and read 6 digits out of the result. Same
 * secret + same time = same code, with nothing sent between them.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A code is valid for one 30-second step (plus one step of clock tolerance). */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encodes bytes as base32, the format authenticator apps expect (RFC 4648). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decodes base32 back into bytes. Throws on characters outside the alphabet. */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('Not a base32 secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 20-byte secret (the RFC-recommended size), as base32 for the app. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The time step a moment belongs to: step 0 was 1 January 1970, 30 seconds each. */
export function totpStep(atMilliseconds: number = Date.now()): number {
  return Math.floor(atMilliseconds / 1000 / TOTP_STEP_SECONDS);
}

/** The code an authenticator app shows for this secret at this time step. */
export function totpCode(secret: string, step: number, digits: number = TOTP_DIGITS): string {
  // The step as an 8-byte big-endian counter, per RFC 4226.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  // "Dynamic truncation": the last 4 bits pick where to read 31 bits from.
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code against the current step and one step either side, because
 * the phone's clock and the server's clock are never exactly equal.
 *
 * Returns the step the code matched, or null. The caller must remember the
 * matched step and refuse it (and everything before it) next time — that is
 * what stops someone who saw a code from using it a second time.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  atMilliseconds: number = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const now = totpStep(atMilliseconds);
  let matched: number | null = null;
  // Check every step even after a match, so timing reveals nothing.
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) {
      matched = step;
    }
  }
  return matched;
}

/** The link an authenticator app can scan as a QR code (the `otpauth://` format). */
export function otpauthUri(email: string, secret: string): string {
  const issuer = 'SAMTEC';
  return `otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
