import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDevice } from '@/lib/device';
import { startHeartbeat } from '@/lib/heartbeat';
import { importSigningKey } from '@/lib/signing';

/**
 * The minute tick.
 *
 * Worth testing properly because of what silently stops without it: the server
 * has no scheduled job, so forgotten clock-outs are never repaired and face
 * templates are never deleted when their time is up. A heartbeat that quietly
 * stopped ticking would look exactly like a working kiosk.
 */
let sent: { url: string; headers: Record<string, string>; body: string }[] = [];
let failNext = false;

/** A short interval, so these tests take milliseconds rather than minutes. */
const TICK = 30;

/** Real time, because these tests use the real clock. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function aPairedKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-26T06:00:00.000Z',
  };
}

beforeEach(() => {
  sent = [];
  failNext = false;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ''),
    });
    if (failNext) {
      return Promise.reject(new Error('no signal at the gate'));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ serverTime: '2026-09-26T06:00:01.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the heartbeat', () => {
  it('ticks straight away, so a kiosk just switched on is counted as seen', async () => {
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, 60_000);
    // The first tick does not wait for the interval.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stop();

    expect(sent[0]?.url).toContain('/ingest/heartbeat');
  });

  it('signs it like every other request, for the heartbeat route', async () => {
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, 60_000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stop();

    const request = sent[0];
    expect(request?.headers['X-Samtec-Device']).toBe('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01');
    expect(request?.headers['X-Samtec-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.headers['X-Samtec-Timestamp']).toMatch(/^\d+$/);
    // The phone's own clock goes with it, so the server can see it drifting.
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      deviceClockAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('keeps ticking on the interval', async () => {
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, TICK);

    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
    stop();
  });

  it('stops when it is told to, and does not keep ticking', async () => {
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, TICK);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));

    stop();
    // Long enough for many more ticks, had the interval survived. A request
    // already in flight when `stop` was called still finishes — that is one
    // heartbeat and harmless — so this settles first, then checks nothing more
    // arrives.
    await pause(TICK * 4);
    const after = sent.length;
    await pause(TICK * 10);

    expect(sent).toHaveLength(after);
  });

  it('keeps going after a failure, because a gate loses signal', async () => {
    failNext = true;
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, TICK);

    // The first tick is refused, the way a gate with no signal refuses it.
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));
    failNext = false;

    // A rejected request must not kill the interval: the whole point is that it
    // tries again, so the count keeps climbing.
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
    stop();
  });
});
