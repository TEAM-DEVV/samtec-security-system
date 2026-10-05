import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PairedDevice } from '@/lib/device';
import { importSigningKey } from '@/lib/signing';
import { callSigned, KioskRequestFailed } from './api';

/**
 * What a kiosk shows for a 401.
 *
 * A route an administrator uses needs both their own access token and this
 * device's signature (`kiosk-operator.guard.ts`), so a 401 there can mean
 * either one. The server answers both the same way — plain "Unauthorized",
 * no code of its own — so `access-token.guard.ts`'s exact words are the only
 * thing that tells an expired sign-in apart from a device the dashboard has
 * refused, and the kiosk has to read them rather than assume the device.
 */

async function aPairedKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-26T06:00:00.000Z',
  };
}

function unauthorized(detail: string) {
  return {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail,
    traceId: 'trace-1',
  };
}

function answerWith(body: unknown, status: number) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callSigned · telling a device 401 apart from an admin one', () => {
  it('blames this device when the signature is what the server refused', async () => {
    answerWith(unauthorized('The device signature is not valid.'), 401);
    const device = await aPairedKiosk();

    const error = await callSigned(device, 'kiosk/identify', {}).catch((caught) => caught);

    expect(error).toBeInstanceOf(KioskRequestFailed);
    expect((error as KioskRequestFailed).message).toMatch(/refused this kiosk/);
    expect((error as KioskRequestFailed).message).toMatch(/Devices page|Devices/);
  });

  it('tells the administrator to sign in again when their own token is the problem', async () => {
    answerWith(unauthorized('Sign in to continue.'), 401);
    const device = await aPairedKiosk();

    const error = await callSigned(device, 'kiosk/consents', {}, 'an-admin-token').catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(KioskRequestFailed);
    expect((error as KioskRequestFailed).message).toMatch(/sign in again/i);
    // The device-focused wording, meant for a different problem, must not
    // also show here — it would send an administrator to the wrong fix.
    expect((error as KioskRequestFailed).message).not.toMatch(/Devices page|switched on/);
  });

  it('falls back to the device wording for a 401 the server sent no words for', async () => {
    answerWith({}, 401);
    const device = await aPairedKiosk();

    const error = await callSigned(device, 'kiosk/identify', {}).catch((caught) => caught);

    expect(error).toBeInstanceOf(KioskRequestFailed);
    expect((error as KioskRequestFailed).message).toMatch(/refused this kiosk/);
  });
});
