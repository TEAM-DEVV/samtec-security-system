/**
 * Password hashing with scrypt, which is built into Node.js.
 *
 * A password is never stored. We store a **hash**: a one-way scramble that
 * lets us check a password without being able to read it back. scrypt is
 * deliberately slow and memory-hungry, so guessing millions of passwords
 * against a stolen database stays impractical (OWASP-recommended settings).
 *
 * The stored text carries its own settings, for example:
 *
 *   scrypt$32768$8$3$<salt in base64>$<hash in base64>
 *
 * so the settings can be raised later without breaking existing accounts.
 */
import {
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

/** Node's scrypt as a promise, keeping the options argument. */
function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export interface ScryptParams {
  /** CPU and memory cost. Must be a power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** How many times the work is repeated. */
  p: number;
}

/** OWASP-recommended strength (about 32 MB of memory, three passes). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 3 };

/** Deliberately weak settings so the test suite stays fast. Never use outside tests. */
export const TEST_ONLY_SCRYPT_PARAMS: ScryptParams = { N: 1_024, r: 8, p: 1 };

const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** scrypt needs a little more memory than N*r*128 bytes; give it headroom. */
function maxmemFor(params: ScryptParams): number {
  return 256 * params.N * params.r;
}

/** Hashes a password for storage. A fresh random salt makes every hash unique. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, HASH_BYTES, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return [
    'scrypt',
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * Checks a password against a stored hash. Always compares in constant time,
 * so an attacker cannot learn anything from how long the check takes.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || expected.length !== HASH_BYTES) {
    return false;
  }
  const actual = await scrypt(password, salt, HASH_BYTES, {
    N,
    r,
    p,
    maxmem: maxmemFor({ N, r, p }),
  });
  return timingSafeEqual(actual, expected);
}

/**
 * A real hash of a long random password nobody knows. When someone tries to
 * sign in with an email that has no account, we check their password against
 * this instead of skipping the check. Both cases then take the same time, so
 * an attacker cannot use timing to discover which emails have accounts.
 */
export const NO_SUCH_USER_HASH =
  'scrypt$32768$8$3$zm5NarKaIoEOyk8oyE7WMw==$gPlGBAUZ00UQNQvXXC/b7+wLEB8jRNQ1rTH273Z2vbw=';
