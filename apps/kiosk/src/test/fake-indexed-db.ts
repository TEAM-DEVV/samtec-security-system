/**
 * A minimal, in-memory stand-in for IndexedDB, covering exactly what
 * `lib/device.ts` uses: named object stores with no key path, `get` / `put` /
 * `delete` / `getAll`, a version-change upgrade that sees the previous
 * version, and transactions that report when every request made on them has
 * settled.
 *
 * jsdom (this project's test environment) does not implement IndexedDB at
 * all, and adding a polyfill package just for one file's tests is against
 * this project's "no new dependency" rule — this is small, test-only, and
 * exactly the same approach `apps/api/test/fakes/` already takes for the
 * database boundary on the API side. Deliberately not a general polyfill: no
 * indexes, no cursors, no key ranges, and no real concurrency control between
 * transactions. `device.test.ts` is the only thing that should import this.
 */

interface FakeRequest<T = unknown> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function pendingRequest<T>(): FakeRequest<T> {
  return {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private pending = 0;
  private settled = false;
  private readonly database: FakeDatabase;

  constructor(database: FakeDatabase) {
    this.database = database;
  }

  objectStore(name: string): FakeObjectStore {
    return new FakeObjectStore(this.database.storeData(name), this);
  }

  /** Runs one store operation as part of this transaction, asynchronously. */
  track<T>(run: () => T): FakeRequest<T> {
    this.pending += 1;
    const request = pendingRequest<T>();
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.();
      } catch (error) {
        request.error = error instanceof Error ? error : new Error(String(error));
        request.onerror?.();
      } finally {
        this.pending -= 1;
        this.completeIfDone();
      }
    });
    return request;
  }

  /** Call once, right after any synchronous work that may have called `track`. */
  settleIfIdle(): void {
    this.completeIfDone();
  }

  private completeIfDone(): void {
    if (this.pending === 0 && !this.settled) {
      this.settled = true;
      queueMicrotask(() => this.oncomplete?.());
    }
  }
}

class FakeObjectStore {
  private readonly data: Map<string, unknown>;
  private readonly transaction: FakeTransaction;

  constructor(data: Map<string, unknown>, transaction: FakeTransaction) {
    this.data = data;
    this.transaction = transaction;
  }

  get(key: string): FakeRequest {
    return this.transaction.track(() => this.data.get(key));
  }

  getAll(): FakeRequest {
    return this.transaction.track(() => [...this.data.values()]);
  }

  put(value: unknown, key: string): FakeRequest {
    return this.transaction.track(() => {
      this.data.set(key, value);
      return key;
    });
  }

  delete(key: string): FakeRequest {
    return this.transaction.track(() => {
      this.data.delete(key);
      return undefined;
    });
  }
}

class FakeDatabase {
  version: number;
  readonly objectStoreNames: { contains: (name: string) => boolean };
  private readonly stores = new Map<string, Map<string, unknown>>();

  constructor(version: number) {
    this.version = version;
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }

  createObjectStore(name: string): void {
    this.stores.set(name, new Map());
  }

  storeData(name: string): Map<string, unknown> {
    const data = this.stores.get(name);
    if (data === undefined) {
      throw new Error(`fake-indexed-db: no object store named "${name}"`);
    }
    return data;
  }

  transaction(_storeNames: string | string[], _mode?: 'readonly' | 'readwrite'): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void {
    // Nothing to release in a fake kept alive by the test itself.
  }
}

interface FakeOpenRequest {
  result: FakeDatabase;
  error: Error | null;
  transaction: FakeTransaction | null;
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

/**
 * One independent set of named databases, so each test starts from nothing
 * and cannot see another test's devices. Opening the same name twice within
 * one instance returns the same database with its data intact — that
 * persistence, within one fake, is what lets a migration test open a
 * version-1 database, then "restart the phone" by opening it again at
 * version 2.
 */
export function createFakeIndexedDB(): IDBFactory {
  const databases = new Map<string, FakeDatabase>();

  function open(name: string, version: number): FakeOpenRequest {
    const request: FakeOpenRequest = {
      result: undefined as unknown as FakeDatabase,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      const existing = databases.get(name);
      const oldVersion = existing?.version ?? 0;
      const database = existing ?? new FakeDatabase(version);
      databases.set(name, database);
      request.result = database;

      const finish = () => {
        database.version = version;
        queueMicrotask(() => request.onsuccess?.());
      };

      if (version > oldVersion) {
        const upgrade = new FakeTransaction(database);
        request.transaction = upgrade;
        upgrade.oncomplete = finish;
        request.onupgradeneeded?.({ oldVersion });
        // Nothing queued during the upgrade (a fresh database, with no
        // legacy record to migrate) would otherwise never reach `oncomplete`.
        upgrade.settleIfIdle();
      } else {
        finish();
      }
    });
    return request;
  }

  return { open } as unknown as IDBFactory;
}
