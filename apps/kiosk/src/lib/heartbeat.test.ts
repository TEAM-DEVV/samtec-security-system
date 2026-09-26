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
  vi.useRealTimers();
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
    vi.useFakeTimers();
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, 1000);

    await vi.advanceTimersByTimeAsync(3500);
    stop();
    // Counted loosely on purpose. Each tick signs before it sends, and signing
    // is asynchronous, so a tick can land just either side of a tick boundary.
    // What matters is that it keeps going, not that it lands on the millisecond.
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  it('stops when it is told to, and does not keep ticking', async () => {
    vi.useFakeTimers();
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, 1000);
    await vi.advanceTimersByTimeAsync(1500);

    stop();
    // Long enough for ten more ticks, had the interval survived.
    await vi.advanceTimersByTimeAsync(10_000);
    const after = sent.length;
    await vi.advanceTimersByTimeAsync(10_000);

    // A request already in flight when `stop` was called still finishes — it is
    // one heartbeat and harmless. What must not happen is the interval carrying
    // on, so the count has to be settled by now.
    expect(sent).toHaveLength(after);
    expect(after).toBeLessThan(5);
  });

  it('keeps going after a failure, because a gate loses signal', async () => {
    vi.useFakeTimers();
    failNext = true;
    const device = await aPairedKiosk();
    const stop = startHeartbeat(device, 1000);

    await vi.advanceTimersByTimeAsync(2500);
    failNext = false;
    await vi.advanceTimersByTimeAsync(2000);
    stop();

    // A rejected request must not kill the interval: the whole point is that it
    // tries again a minute later.
    expect(sent.length).toBeGreaterThan(3);
  });
});
