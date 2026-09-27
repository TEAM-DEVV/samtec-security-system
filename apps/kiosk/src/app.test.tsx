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
vi.mock('@/lib/device', () => ({ loadDevice, forgetDevice }));

let answers: { status: number; body: unknown }[] = [];
let sent: string[] = [];

async function aPairedKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-26T06:00:00.000Z',
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

beforeEach(() => {
  answers = [];
  sent = [];
  loadDevice.mockReset();
  forgetDevice.mockReset();
  forgetDevice.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', (url: string) => {
    sent.push(url);
    // The heartbeat starts as soon as the app pairs, and it is not what these
    // tests are about, so it always succeeds.
    if (url.includes('/ingest/heartbeat')) {
      return Promise.resolve(
        new Response(JSON.stringify({ serverTime: '2026-09-26T06:00:01.000Z' }), { status: 200 }),
      );
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
    await screen.findByText('This device is not switched on.', {}, { timeout: 8000 });

    // A well-formed but wrong secret pairs happily and then fails every request.
    // Without this the phone has no way back at all.
    await user.click(screen.getByRole('button', { name: 'Set this phone up again' }));
    expect(forgetDevice).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Set this phone up' })).toBeInTheDocument();
  });
});
