import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from '@/test/fake-indexed-db';
import { forgetDevice, listDevices, loadDevice, pairDevice, switchDevice } from './device';
import { importSigningKey } from './signing';

/**
 * What this phone remembers about being a kiosk.
 *
 * The one rule this file exists to prove, in every shape the store can be in:
 * the secret is never kept as text, only as a key the browser will not read
 * back. jsdom has no real IndexedDB, so these run against a small hand-written
 * stand-in (`@/test/fake-indexed-db.ts`) that behaves like it for exactly what
 * this module does — see that file for why.
 */

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const A_SECRET = 'sk_test_only_not_a_real_device_secret_a';
const B_SECRET = 'sk_test_only_not_a_real_device_secret_b';

/** Writes a record in the pre-task-2 shape: one fixed key, version 1. */
async function seedLegacyDevice(record: {
  deviceId: string;
  name: string;
  key: CryptoKey;
  pairedAt: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('samtec-kiosk', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('device');
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('device', 'readwrite');
      transaction.objectStore('device').put(record, 'this-device');
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe('keys never stored as text', () => {
  it('turns a paired secret into a non-extractable key', async () => {
    const paired = await pairDevice('01927c3e-0000-7000-8000-000000000001', A_SECRET, 'Gate A');

    expect(paired.key).toBeInstanceOf(CryptoKey);
    expect(paired.key.extractable).toBe(false);

    const loaded = await loadDevice();
    expect(loaded?.key).toBeInstanceOf(CryptoKey);
    expect(loaded?.key.extractable).toBe(false);
  });

  it('never puts a key, or anything secret-shaped, in the settings list', async () => {
    await pairDevice('01927c3e-0000-7000-8000-000000000001', A_SECRET, 'Gate A');

    const [summary] = await listDevices();

    expect(summary).toEqual({
      deviceId: '01927c3e-0000-7000-8000-000000000001',
      name: 'Gate A',
      pairedAt: expect.any(String),
      active: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(/sk_test|key/i);
  });
});

describe('migrating the old single-device record', () => {
  it('moves a phone already set up under version 1 to the per-device shape', async () => {
    const key = await importSigningKey(A_SECRET);
    await seedLegacyDevice({
      deviceId: '01927c3e-1111-7000-8000-000000000002',
      name: 'Main Gate kiosk',
      key,
      pairedAt: '2026-09-01T06:00:00.000Z',
    });

    const loaded = await loadDevice();

    expect(loaded).toMatchObject({
      deviceId: '01927c3e-1111-7000-8000-000000000002',
      name: 'Main Gate kiosk',
      pairedAt: '2026-09-01T06:00:00.000Z',
    });
    expect(loaded?.key).toBeInstanceOf(CryptoKey);
    expect(loaded?.key.extractable).toBe(false);

    // Migrated into the list, as the one stored device, and already active —
    // a phone that was already working must keep working with no extra tap.
    const devices = await listDevices();
    expect(devices).toEqual([
      {
        deviceId: '01927c3e-1111-7000-8000-000000000002',
        name: 'Main Gate kiosk',
        pairedAt: '2026-09-01T06:00:00.000Z',
        active: true,
      },
    ]);
  });

  it('leaves a phone with nothing stored yet alone', async () => {
    // No legacy record at all: a brand new phone, never set up.
    expect(await loadDevice()).toBeNull();
    expect(await listDevices()).toEqual([]);
  });
});

describe('switching the active device', () => {
  it('moves which device loadDevice and listDevices report as active', async () => {
    const a = await pairDevice('01927c3e-0000-7000-8000-00000000000a', A_SECRET, 'Gate A');
    await pairDevice('01927c3e-0000-7000-8000-00000000000b', B_SECRET, 'Gate B');
    // Pairing a second device makes it active; switch back to the first.

    const switched = await switchDevice(a.deviceId);

    expect(switched).toMatchObject({ deviceId: a.deviceId, name: 'Gate A' });
    expect((await loadDevice())?.deviceId).toBe(a.deviceId);
    const active = (await listDevices()).filter((device) => device.active);
    expect(active).toEqual([expect.objectContaining({ deviceId: a.deviceId })]);
  });

  it('refuses to switch to a device this phone does not have', async () => {
    await pairDevice('01927c3e-0000-7000-8000-00000000000a', A_SECRET, 'Gate A');

    const result = await switchDevice('01927c3e-0000-7000-8000-00000000dead');

    expect(result).toBeNull();
    // Still on the one device this phone actually has.
    expect((await loadDevice())?.deviceId).toBe('01927c3e-0000-7000-8000-00000000000a');
  });
});

describe('forgetting a device', () => {
  it('leaves the active device alone when some other device is forgotten', async () => {
    const a = await pairDevice('01927c3e-0000-7000-8000-00000000000a', A_SECRET, 'Gate A');
    const b = await pairDevice('01927c3e-0000-7000-8000-00000000000b', B_SECRET, 'Gate B');
    await switchDevice(a.deviceId);

    const result = await forgetDevice(b.deviceId);

    expect(result).toMatchObject({ deviceId: a.deviceId });
    expect((await loadDevice())?.deviceId).toBe(a.deviceId);
    expect(await listDevices()).toEqual([
      expect.objectContaining({ deviceId: a.deviceId, active: true }),
    ]);
  });

  it('falls back to another stored device when the active one is forgotten', async () => {
    const a = await pairDevice('01927c3e-0000-7000-8000-00000000000a', A_SECRET, 'Gate A');
    await pairDevice('01927c3e-0000-7000-8000-00000000000b', B_SECRET, 'Gate B');
    await switchDevice(a.deviceId);

    // No ID given: forgets whichever device is active right now (Gate A).
    const fallback = await forgetDevice();

    expect(fallback).toMatchObject({ deviceId: '01927c3e-0000-7000-8000-00000000000b' });
    expect((await loadDevice())?.deviceId).toBe('01927c3e-0000-7000-8000-00000000000b');
    expect(await listDevices()).toEqual([
      expect.objectContaining({ deviceId: '01927c3e-0000-7000-8000-00000000000b', active: true }),
    ]);
  });

  it('falls back to the set-up form when no device is left', async () => {
    await pairDevice('01927c3e-0000-7000-8000-00000000000a', A_SECRET, 'Gate A');

    const result = await forgetDevice();

    expect(result).toBeNull();
    expect(await loadDevice()).toBeNull();
    expect(await listDevices()).toEqual([]);
  });
});
