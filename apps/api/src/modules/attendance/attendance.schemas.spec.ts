import { describe, expect, it } from 'vitest';
import { registerDeviceSchema } from './attendance.schemas.js';

/**
 * `passkeysEnabled` at registration (Phase 7 follow-up, issue #99 Task 3): an
 * optional boolean, so a request made before this field existed still parses
 * exactly as it did before.
 */
describe('registerDeviceSchema', () => {
  const base = {
    name: 'Ridge Towers main gate',
    siteId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    kind: 'FACE_KIOSK' as const,
  };

  it('leaves passkeysEnabled unset when the request does not send it', () => {
    const parsed = registerDeviceSchema.parse(base);
    expect(parsed.passkeysEnabled).toBeUndefined();
  });

  it('accepts passkeysEnabled true or false', () => {
    expect(registerDeviceSchema.parse({ ...base, passkeysEnabled: true }).passkeysEnabled).toBe(
      true,
    );
    expect(registerDeviceSchema.parse({ ...base, passkeysEnabled: false }).passkeysEnabled).toBe(
      false,
    );
  });

  it('refuses anything other than true or false', () => {
    expect(() => registerDeviceSchema.parse({ ...base, passkeysEnabled: 'yes' })).toThrow();
  });
});
