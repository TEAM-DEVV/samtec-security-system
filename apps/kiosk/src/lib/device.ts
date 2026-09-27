import { importSigningKey } from '@/lib/signing';

/**
 * What this phone knows about being a kiosk, and where it keeps it.
 *
 * The device secret is turned into a non-extractable `CryptoKey` the moment it
 * arrives and only the key object is stored. IndexedDB can hold a `CryptoKey`
 * as-is, so the browser keeps the bytes and never hands them back — not to us,
 * and not to anything that later manages to run on this page. `localStorage`
 * could not do this: it stores text, so the secret would be readable forever by
 * one line of script.
 *
 * Design: docs/plan/13-biometrics-design.md sections 2 and 8.
 */

const DATABASE = 'samtec-kiosk';
const STORE = 'device';
const RECORD = 'this-device';

/** What the kiosk remembers between visits. */
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

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The kiosk store would not open.'));
  });
}

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The kiosk store would not answer.'));
  });
}

/** The paired device, or `null` on a phone that has not been set up yet. */
export async function loadDevice(): Promise<PairedDevice | null> {
  const database = await open();
  try {
    const stored = await asPromise<StoredDevice | undefined>(
      database.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD),
    );
    // A record written by an older version, or a browser that dropped the key
    // object, is no record at all — better to ask for pairing again than to
    // fail every request with a key that is not a key.
    if (stored === undefined || !(stored.key instanceof CryptoKey)) {
      return null;
    }
    return stored;
  } finally {
    database.close();
  }
}

/**
 * Pairs this phone with a kiosk that an administrator registered on the
 * dashboard.
 *
 * The raw secret is a parameter and nothing else: it is imported into a key
 * here and never written down, so it exists in readable form for as long as
 * this function runs and no longer.
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
    const transaction = database.transaction(STORE, 'readwrite');
    await asPromise(transaction.objectStore(STORE).put(record, RECORD));
    return record;
  } finally {
    database.close();
  }
}

/**
 * Forgets this kiosk.
 *
 * For a phone leaving service, and for the person setting one up who pasted the
 * wrong secret. The dashboard still has to switch the device off — this only
 * clears the phone.
 */
export async function forgetDevice(): Promise<void> {
  const database = await open();
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    await asPromise(transaction.objectStore(STORE).delete(RECORD));
  } finally {
    database.close();
  }
}
