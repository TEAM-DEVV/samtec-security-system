import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import type { PairedDevice } from '@/lib/device';
import { importSigningKey } from '@/lib/signing';

/**
 * The app as a whole, driven the way the running app is driven.
 *
 * This file exists because of a specific mistake. The pretend camera used to
 * wait for a *test* to tell it which way the head had turned, and the screen
 * never told it — so every attempt in the running app timed out after twenty
 * seconds and `pnpm dev:kiosk` could not clock anybody in. The screen tests all
 * passed, because each one reached in and set that field by hand.
 *
 * So nothing here touches the engine's internals. If the app cannot clock
 * somebody in through `App`, these tests fail.
 */
const loadDevice = vi.hoisted(() => vi.fn());
const forgetDevice = vi.hoisted(() => vi.fn());
// Settings needs these two as well, but only the switching test below gives
// them anything to do — every other test never opens kiosk settings.
const listDevices = vi.hoisted(() => vi.fn());
const switchDevice = vi.hoisted(() => vi.fn());
vi.mock('@/lib/device', () => ({ loadDevice, forgetDevice, listDevices, switchDevice }));

let answers: { status: number; body: unknown }[] = [];
let sent: string[] = [];
/** Which device signed each heartbeat, in order — for the device-switch test only. */
let heartbeatDeviceIds: string[] = [];
/** What every heartbeat answers with for `passkeysEnabled`, until a test says otherwise. */
let heartbeatPasskeysEnabled = true;

async function aPairedKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-26T06:00:00.000Z',
  };
}

/** A second device, stored on the same phone, this kiosk is not acting as yet. */
async function aSecondStoredKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c09',
    name: 'Side gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret_two'),
    pairedAt: '2026-09-27T06:00:00.000Z',
  };
}

const MATCHED = {
  status: 200,
  body: {
    attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c02',
    outcome: 'MATCHED',
    worker: { displayName: 'Kwame A.', staffNumber: 'SMT-00042' },
    fingerprint: null,
  },
};

const PUNCHED = {
  status: 200,
  body: {
    punchId: '01927c3e-3333-7aaa-8bbb-0c0c0c0c0c04',
    status: 'ACCEPTED',
    method: 'FACE',
    direction: 'IN',
    recordedAt: '2026-09-26T06:01:00.000Z',
    worker: { displayName: 'Kwame A.', staffNumber: 'SMT-00042' },
  },
};

/** What signing in as an administrator answers, with no two-factor code needed. */
const ADMIN_SESSION = {
  status: 'AUTHENTICATED',
  accessToken: 'kiosk-token',
  expiresInSeconds: 900,
  user: {
    id: '01927c3e-aaaa-7000-8000-000000000001',
    email: 'admin@samtec.example',
    fullName: 'Ama Boateng',
    role: 'ADMIN',
    twoFactorEnabled: true,
    employeeId: null,
  },
};

beforeEach(() => {
  answers = [];
  sent = [];
  heartbeatDeviceIds = [];
  heartbeatPasskeysEnabled = true;
  loadDevice.mockReset();
  forgetDevice.mockReset();
  // `forgetDevice` now reports the device it leaves this phone acting as —
  // `null` once nothing is left, which is also what sends the app back to the
  // set-up form (`app.tsx` passes this straight to `setDevice`).
  forgetDevice.mockResolvedValue(null);
  listDevices.mockReset();
  listDevices.mockResolvedValue([]);
  switchDevice.mockReset();
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    sent.push(url);
    // The heartbeat starts as soon as the app pairs, and it is not what these
    // tests are about, so it always succeeds.
    if (url.includes('/ingest/heartbeat')) {
      const headers = (init.headers ?? {}) as Record<string, string>;
      // Only the switching test reads this; every other test ignores it.
      heartbeatDeviceIds.push(headers['X-Samtec-Device'] ?? '');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            serverTime: '2026-09-26T06:00:01.000Z',
            passkeysEnabled: heartbeatPasskeysEnabled,
          }),
          { status: 200 },
        ),
      );
    }
    // Signing in and out is not what the admin-menu tests are about either —
    // `admin-sign-in-screen.test.tsx` already covers the sign-in form itself.
    if (url.includes('/auth/login')) {
      return Promise.resolve(new Response(JSON.stringify(ADMIN_SESSION), { status: 200 }));
    }
    if (url.includes('/auth/logout')) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const next = answers.shift();
    if (next === undefined) {
      throw new Error(`Unexpected request to ${url}`);
    }
    return Promise.resolve(
      new Response(next.status === 204 ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

/** Signs in as an administrator, from the Ready screen. */
async function signInAsAdmin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Admin' }));
  await user.type(screen.getByLabelText('Email'), 'admin@samtec.example');
  await user.type(screen.getByLabelText('Password'), 'demo-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('asks for set-up on a phone that is not a kiosk yet', async () => {
    loadDevice.mockResolvedValue(null);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Set this phone up' })).toBeInTheDocument();
  });

  it('clocks somebody in end to end, with nothing driving the camera', async () => {
    // The whole point of this file. No engine is passed, so the app builds its
    // own; nothing here tells it which way the head turned.
    loadDevice.mockResolvedValue(await aPairedKiosk());
    answers = [MATCHED, PUNCHED];
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Start shift' }));

    // Longer than the default one second: the gesture takes a few frames and
    // then the real screen holds the name for two seconds before punching, which
    // is the wait that makes "Not me" possible.
    expect(
      await screen.findByRole('heading', { name: 'Shift started' }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(sent.some((url) => url.includes('/kiosk/identify'))).toBe(true);
    expect(sent.some((url) => url.includes('/kiosk/confirm'))).toBe(true);
  });

  it('starts the heartbeat as soon as it is paired', async () => {
    // Nothing else deletes old biometrics or repairs a forgotten clock-out.
    loadDevice.mockResolvedValue(await aPairedKiosk());
    render(<App />);
    await screen.findByRole('button', { name: 'Start shift' });

    await vi.waitFor(() =>
      expect(sent.some((url) => url.includes('/ingest/heartbeat'))).toBe(true),
    );
  });

  it('says so, rather than showing a set-up form it cannot finish', async () => {
    // A browser that will not open IndexedDB cannot hold a signing key at all.
    loadDevice.mockRejectedValue(new Error('no indexeddb'));
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'This phone cannot be a kiosk' }),
    ).toBeInTheDocument();
  });

  it('offers set-up again when the server refuses this phone, and forgets it', async () => {
    loadDevice.mockResolvedValue(await aPairedKiosk());
    answers = [
      {
        status: 401,
        body: {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'This device is not switched on.',
          traceId: 'trace-1',
        },
      },
    ];
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Start shift' }));
    await screen.findByText(/refused this kiosk/, {}, { timeout: 8000 });

    // A well-formed but wrong secret pairs happily and then fails every request.
    // Without this the phone has no way back at all.
    await user.click(screen.getByRole('button', { name: 'Set this phone up again' }));
    expect(forgetDevice).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Set this phone up' })).toBeInTheDocument();
  });

  it('opens the admin menu on sign-in, not the enrol screen directly', async () => {
    loadDevice.mockResolvedValue(await aPairedKiosk());
    const user = userEvent.setup();
    render(<App />);

    await signInAsAdmin(user);

    expect(await screen.findByRole('heading', { name: 'Admin menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enroll a worker’s face' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save a fingerprint' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kiosk settings' })).toBeInTheDocument();
  });

  it('says fingerprints are off, with no dead button, when the heartbeat says so', async () => {
    heartbeatPasskeysEnabled = false;
    loadDevice.mockResolvedValue(await aPairedKiosk());
    const user = userEvent.setup();
    render(<App />);
    // The heartbeat that answers this ticks as soon as the phone is paired,
    // before anyone could reach the menu — give it a moment to land.
    await vi.waitFor(() =>
      expect(sent.some((url) => url.includes('/ingest/heartbeat'))).toBe(true),
    );

    await signInAsAdmin(user);

    expect(await screen.findByRole('heading', { name: 'Admin menu' })).toBeInTheDocument();
    expect(screen.getByText(/Fingerprints are switched off for this kiosk/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save a fingerprint' })).not.toBeInTheDocument();
    // Every other item still works.
    expect(screen.getByRole('button', { name: 'Enroll a worker’s face' })).toBeInTheDocument();
  });

  it('returns to the menu from a task, and only signs out from "Back to clock-in"', async () => {
    loadDevice.mockResolvedValue(await aPairedKiosk());
    answers = [
      { status: 200, body: { version: 'bio-v1', text: 'Consent text.', sha256: 'a'.repeat(64) } },
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { items: [], nextCursor: null } },
    ];
    const user = userEvent.setup();
    render(<App />);

    await signInAsAdmin(user);
    await user.click(await screen.findByRole('button', { name: 'Enroll a worker’s face' }));
    expect(
      await screen.findByRole('heading', { name: 'Who is being enrolled?' }),
    ).toBeInTheDocument();

    // Leaving the enrol screen comes back here — an administrator doing two
    // things should not have to sign in twice.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Admin menu' })).toBeInTheDocument();
    expect(sent.some((url) => url.includes('/auth/logout'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Back to clock-in' }));
    expect(await screen.findByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    expect(sent.some((url) => url.includes('/auth/logout'))).toBe(true);
  });

  it('switches which device the heartbeat follows, and never runs two at once', async () => {
    // Nothing else deletes old biometrics or repairs a forgotten clock-out,
    // so a switch that left the old interval running, or failed to start a
    // new one, would be silently serious rather than loudly broken.
    const gateA = await aPairedKiosk();
    const gateB = await aSecondStoredKiosk();
    loadDevice.mockResolvedValue(gateA);
    listDevices.mockResolvedValue([
      { deviceId: gateA.deviceId, name: gateA.name, pairedAt: gateA.pairedAt, active: true },
      { deviceId: gateB.deviceId, name: gateB.name, pairedAt: gateB.pairedAt, active: false },
    ]);
    switchDevice.mockResolvedValue(gateB);
    const user = userEvent.setup();
    render(<App />);

    // The first heartbeat, for the device the phone started as.
    await vi.waitFor(() => expect(heartbeatDeviceIds).toContain(gateA.deviceId));

    await signInAsAdmin(user);
    // Signing in restarts the heartbeat at the faster admin pace, which beats
    // at once — so a fingerprint switch flipped on the dashboard shows here
    // straight away. Still device A, and still only one heartbeat running.
    await vi.waitFor(() =>
      expect(heartbeatDeviceIds.filter((id) => id === gateA.deviceId)).toHaveLength(2),
    );
    const heartbeatsBeforeSwitch = heartbeatDeviceIds.length;
    await user.click(await screen.findByRole('button', { name: 'Kiosk settings' }));
    await user.click(await screen.findByRole('button', { name: /Switch to Side gate kiosk/ }));

    expect(switchDevice).toHaveBeenCalledWith(gateB.deviceId);
    // Switching fires a new heartbeat straight away (`startHeartbeat`'s own
    // "counted as seen without waiting a minute"), so one more call is the new
    // device's, not a second one from the old interval still running.
    await vi.waitFor(() =>
      expect(heartbeatDeviceIds.length).toBeGreaterThan(heartbeatsBeforeSwitch),
    );
    // Only ever one device at a time — the old interval must not still be
    // ticking alongside the new one, which a stuck interval would show as a
    // second A arriving after B's first heartbeat.
    const afterSwitch = heartbeatDeviceIds.slice(heartbeatsBeforeSwitch);
    expect(afterSwitch.every((id) => id === gateB.deviceId)).toBe(true);
    expect(heartbeatDeviceIds.filter((id) => id === gateA.deviceId)).toHaveLength(2);
  });
});
