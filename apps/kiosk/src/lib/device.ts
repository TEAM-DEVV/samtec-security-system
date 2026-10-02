import { importSigningKey } from '@/lib/signing';

/**
 * What this phone knows about being a kiosk, and where it keeps it.
 *
 * Every device secret is turned into a non-extractable `CryptoKey` the moment
 * it arrives and only the key object is stored. IndexedDB can hold a
 * `CryptoKey` as-is, so the browser keeps the bytes and never hands them
 * back — not to us, and not to anything that later manages to run on this
 * page. `localStorage` could not do this: it stores text, so the secret
 * would be readable forever by one line of script. That rule does not change
 * just because a phone can now hold more than one device.
 *
 * A phone can be registered as more than one device at once (testing needs
 * this: a handful of phones standing in for a kiosk fleet). Each device's
 * record is kept under its own `deviceId`, in the same object store a single
 * phone used to use one fixed key for, and one small "active device" record
 * says which one this phone is acting as right now — the one the heartbeat
 * ticks for and every signed request carries. A phone already set up before
 * this file supported more than one device had its single record migrated
 * into this shape the first time it opens the store again (see `open`
 * below), so it keeps working with no action from anyone.
 *
 * Design: docs/plan/13-biometrics-design.md sections 2 and 8; issue #99 task 2.
 */

const DATABASE = 'samtec-kiosk';
/** Bumped once, to add the devices-plural shape and the active-device record. */
const DB_VERSION = 2;
const DEVICES_STORE = 'device';
const META_STORE = 'meta';
const ACTIVE_KEY = 'active';
/** Where a single-device phone kept its one record, before version 2. */
const LEGACY_KEY = 'this-device';

/** What the kiosk remembers between visits, for the device it is acting as. */
export interface PairedDevice {
  deviceId: string;
  /** What to call this kiosk on screen, for the person setting it up. */
  name: string;
  /** The signing key. Usable, never readable. */
  key: CryptoKey;
  pairedAt: string;
}

/** What is written to IndexedDB. The same, and the key is the browser's object. */
interface StoredDevice {
  deviceId: string;
  name: string;
  key: CryptoKey;
  pairedAt: string;
}

/** One row of the devices list in kiosk settings. */
export interface StoredDeviceSummary {
  deviceId: string;
  name: string;
  pairedAt: string;
  /** Whether this is the device the heartbeat and every signed request use. */
  active: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DEVICES_STORE)) {
        database.createObjectStore(DEVICES_STORE);
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
      // A phone already set up under version 1 kept its one device at the
      // fixed key `this-device`. Move it to a key of its own `deviceId` — the
      // shape every version from here on uses — and make it the active
      // device, so a phone that already worked keeps working untouched.
      if (event.oldVersion < 2) {
        const transaction = request.transaction;
        if (transaction !== null) {
          const devices = transaction.objectStore(DEVICES_STORE);
          const legacy = devices.get(LEGACY_KEY);
          legacy.onsuccess = () => {
            const record = legacy.result as StoredDevice | undefined;
            if (record !== undefined && record.deviceId !== undefined) {
              devices.delete(LEGACY_KEY);
              devices.put(record, record.deviceId);
              transaction.objectStore(META_STORE).put(record.deviceId, ACTIVE_KEY);
            }
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The kiosk store would not open.'));
    request.onblocked = () =>
      reject(new Error('The kiosk store is open elsewhere. Close other tabs of this kiosk.'));
  });
}

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The kiosk store would not answer.'));
  });
}

/** Waits for every request already made against a transaction to settle. */
function whenDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('The kiosk store transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('The kiosk store transaction was aborted.'));
  });
}

async function activeDeviceId(database: IDBDatabase): Promise<string | undefined> {
  return asPromise<string | undefined>(
    database.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(ACTIVE_KEY),
  );
}

async function setActiveDeviceId(database: IDBDatabase, deviceId: string): Promise<void> {
  const transaction = database.transaction(META_STORE, 'readwrite');
  transaction.objectStore(META_STORE).put(deviceId, ACTIVE_KEY);
  await whenDone(transaction);
}

/**
 * One stored device, or `undefined` for an ID this phone does not have — or
 * for a record an older version wrote and a browser then dropped the key
 * object from. Either is no record at all: better to say so than to fail
 * every request with a key that is not a key.
 */
async function storedDevice(
  database: IDBDatabase,
  deviceId: string,
): Promise<StoredDevice | undefined> {
  const record = await asPromise<StoredDevice | undefined>(
    database.transaction(DEVICES_STORE, 'readonly').objectStore(DEVICES_STORE).get(deviceId),
  );
  return record !== undefined && record.key instanceof CryptoKey ? record : undefined;
}

async function allStoredDevices(database: IDBDatabase): Promise<StoredDevice[]> {
  const all = await asPromise<StoredDevice[]>(
    database.transaction(DEVICES_STORE, 'readonly').objectStore(DEVICES_STORE).getAll(),
  );
  return all.filter((record) => record.key instanceof CryptoKey);
}

/** Most recently paired first, so both the settings list and a fallback choice agree. */
function newestFirst(devices: StoredDevice[]): StoredDevice[] {
  return [...devices].sort((a, b) =>
    a.pairedAt > b.pairedAt ? -1 : a.pairedAt < b.pairedAt ? 1 : 0,
  );
}

/** The active device, or `null` on a phone that has not been set up yet. */
export async function loadDevice(): Promise<PairedDevice | null> {
  const database = await open();
  try {
    const id = await activeDeviceId(database);
    if (id === undefined) {
      return null;
    }
    return (await storedDevice(database, id)) ?? null;
  } finally {
    database.close();
  }
}

/**
 * Pairs this phone with a kiosk that an administrator registered on the
 * dashboard, and makes it the active device.
 *
 * The raw secret is a parameter and nothing else: it is imported into a key
 * here and never written down, so it exists in readable form for as long as
 * this function runs and no longer. Reachable any time from kiosk settings,
 * not only on a phone's very first set-up — that is what lets one phone
 * stand in for more than one device.
 */
export async function pairDevice(
  deviceId: string,
  secret: string,
  name: string,
  at: Date = new Date(),
): Promise<PairedDevice> {
  const key = await importSigningKey(secret);
  const record: StoredDevice = { deviceId, name, key, pairedAt: at.toISOString() };
  const database = await open();
  try {
    const transaction = database.transaction(DEVICES_STORE, 'readwrite');
    transaction.objectStore(DEVICES_STORE).put(record, deviceId);
    await whenDone(transaction);
    await setActiveDeviceId(database, deviceId);
    return record;
  } finally {
    database.close();
  }
}

/** Every device this phone has stored, for the settings list. */
export async function listDevices(): Promise<StoredDeviceSummary[]> {
  const database = await open();
  try {
    const [all, activeId] = await Promise.all([
      allStoredDevices(database),
      activeDeviceId(database),
    ]);
    return newestFirst(all).map((record) => ({
      deviceId: record.deviceId,
      name: record.name,
      pairedAt: record.pairedAt,
      active: record.deviceId === activeId,
    }));
  } finally {
    database.close();
  }
}

/**
 * Switches which stored device this phone acts as. The heartbeat and every
 * signed request follow whichever device is active, so nothing else has to
 * be told about a switch.
 *
 * `null` if `deviceId` is not one this phone has stored — the list in kiosk
 * settings cannot offer one that is not, but a tap and a forget racing each
 * other should not pretend to switch to a device that is no longer there.
 */
export async function switchDevice(deviceId: string): Promise<PairedDevice | null> {
  const database = await open();
  try {
    const record = await storedDevice(database, deviceId);
    if (record === undefined) {
      return null;
    }
    await setActiveDeviceId(database, deviceId);
    return record;
  } finally {
    database.close();
  }
}

/**
 * Forgets one device: the active one, unless another ID is given.
 *
 * For a phone leaving service, and for the person setting one up who pasted
 * the wrong secret. The dashboard still has to switch the device off — this
 * only clears the phone.
 *
 * Returns the device this phone is left acting as: the same one if some
 * other device was forgotten, another stored device if the active one was
 * (the most recently paired of what is left), or `null` if none are left —
 * in which case the phone has nothing to be a kiosk with any more, and needs
 * the set-up form again.
 */
export async function forgetDevice(deviceId?: string): Promise<PairedDevice | null> {
  const database = await open();
  try {
    const activeId = await activeDeviceId(database);
    const target = deviceId ?? activeId;
    if (target === undefined) {
      return null;
    }

    const deleteTransaction = database.transaction(DEVICES_STORE, 'readwrite');
    deleteTransaction.objectStore(DEVICES_STORE).delete(target);
    await whenDone(deleteTransaction);

    if (target !== activeId) {
      // Some other device was forgotten: what this phone is acting as does
      // not change.
      return activeId === undefined ? null : ((await storedDevice(database, activeId)) ?? null);
    }

    const fallback = newestFirst(await allStoredDevices(database))[0];
    if (fallback === undefined) {
      // Nothing left to be active. Clear the pointer rather than leave it
      // naming a device that is no longer stored.
      const clearTransaction = database.transaction(META_STORE, 'readwrite');
      clearTransaction.objectStore(META_STORE).delete(ACTIVE_KEY);
      await whenDone(clearTransaction);
      return null;
    }
    await setActiveDeviceId(database, fallback.deviceId);
    return fallback;
  } finally {
    database.close();
  }
}
