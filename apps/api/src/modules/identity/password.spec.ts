import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  NO_SUCH_USER_HASH,
  TEST_ONLY_SCRYPT_PARAMS,
  verifyPassword,
} from './password.js';

// The weak TEST_ONLY settings keep these tests fast. Real hashing uses
// DEFAULT_SCRYPT_PARAMS; the format and the checks are identical.
const params = TEST_ONLY_SCRYPT_PARAMS;

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct-horse-battery-staple', params);

    expect(await verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
    expect(await verifyPassword('correct-horse-battery-stable', stored)).toBe(false);
  });

  it('hashes the same password differently every time (unique salts)', async () => {
    const first = await hashPassword('demo-password', params);
    const second = await hashPassword('demo-password', params);

    expect(first).not.toBe(second);
    expect(await verifyPassword('demo-password', first)).toBe(true);
    expect(await verifyPassword('demo-password', second)).toBe(true);
  });

  it('records its settings in the stored text', async () => {
    const stored = await hashPassword('demo-password', params);

    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$/);
  });

  it('rejects a stored value that is not one of our hashes', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$0$0$0$$')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('has a stand-in hash that matches no real password', async () => {
    expect(await verifyPassword('demo-password', NO_SUCH_USER_HASH)).toBe(false);
    expect(await verifyPassword('', NO_SUCH_USER_HASH)).toBe(false);
  });
});
