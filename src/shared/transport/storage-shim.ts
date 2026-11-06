import type { TabStorageArea, TabStorageSnapshot } from '@/shared/types';

/**
 * Stand-ins for the browser APIs a sandboxed frame (no `allow-same-origin`) is
 * not allowed to touch. Merely *reading* `localStorage`, `sessionStorage`,
 * `document.cookie` or `navigator.serviceWorker` throws a SecurityError there,
 * and several modules (chatDrafts, the user-preference mirror) read storage at
 * import time, so this must be installed before any application import.
 *
 * Storage is plain memory, mirrored to the Controller page over the tab's
 * MessagePort. The page keeps the copy under `remote:<peerId>:<area>:<key>` and
 * sends it back in `init`, so a reload keeps `activeTab`, `permissionMode` and
 * friends without the frame ever touching real storage.
 */

/** One mutation of a shimmed storage area; `key: null` means the whole area was cleared, `value: null` means the key was removed. */
export type StorageWrite = { area: TabStorageArea; key: string | null; value: string | null };

/** Handle returned by installStorageShim: lets the tab channel fill the shim from `init` and observe writes. */
export type StorageShim = {
  /** Replaces the contents of both areas without reporting them as writes. */
  loadSnapshot: (snapshot: TabStorageSnapshot) => void;
  /** Receives every later write (or null to stop); the channel forwards them as `storage-set`. */
  setWriteListener: (listener: ((write: StorageWrite) => void) | null) => void;
};

type MemoryStorage = { storage: Storage; load: (entries: Record<string, string>) => void };

const STORAGE_METHODS = new Set(['length', 'key', 'getItem', 'setItem', 'removeItem', 'clear']);

/** Builds a Storage backed by a Map; `load` fills it without calling `onWrite`. */
const buildMemoryStorage = (onWrite?: (key: string | null, value: string | null) => void): MemoryStorage => {
  const entries = new Map<string, string>();

  const methods = {
    get length() {
      return entries.size;
    },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
      onWrite?.(String(key), String(value));
    },
    removeItem: (key: string) => {
      if (entries.delete(String(key))) {
        onWrite?.(String(key), null);
      }
    },
    clear: () => {
      entries.clear();
      onWrite?.(null, null);
    },
  };

  // A Proxy so `storage.theme` / `delete storage.theme` / Object.keys(storage)
  // behave like the real thing, which some libraries rely on.
  const storage = new Proxy(Object.create(methods) as object, {
    get: (target, prop, receiver) =>
      typeof prop === 'string' && !STORAGE_METHODS.has(prop)
        ? entries.get(prop)
        : Reflect.get(target, prop, receiver),
    set: (_target, prop, value) => {
      if (typeof prop === 'string' && !STORAGE_METHODS.has(prop)) {
        methods.setItem(prop, value);
      }
      return true;
    },
    deleteProperty: (_target, prop) => {
      if (typeof prop === 'string') {
        methods.removeItem(prop);
      }
      return true;
    },
    has: (target, prop) => (typeof prop === 'string' ? entries.has(prop) || STORAGE_METHODS.has(prop) : prop in target),
    ownKeys: () => Array.from(entries.keys()),
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && entries.has(prop)
        ? { value: entries.get(prop), writable: true, enumerable: true, configurable: true }
        : undefined,
  }) as Storage;

  return {
    storage,
    load: (loaded) => {
      entries.clear();
      for (const [key, value] of Object.entries(loaded)) {
        entries.set(key, String(value));
      }
    },
  };
};

/**
 * Replaces `localStorage`, `sessionStorage` and `document.cookie` with in-memory
 * stand-ins. Must run before anything reads them; the real objects are never
 * consulted, so nothing of the Controller's storage can leak into the frame.
 */
export const installStorageShim = (win: Window = window): StorageShim => {
  let listener: ((write: StorageWrite) => void) | null = null;
  const report = (area: TabStorageArea) => (key: string | null, value: string | null) =>
    listener?.({ area, key, value });

  const local = buildMemoryStorage(report('local'));
  const session = buildMemoryStorage(report('session'));

  Object.defineProperty(win, 'localStorage', { configurable: true, enumerable: true, get: () => local.storage });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, enumerable: true, get: () => session.storage });
  Object.defineProperty(win.document, 'cookie', { configurable: true, get: () => '', set: () => undefined });

  return {
    loadSnapshot: (snapshot) => {
      local.load(snapshot.local);
      session.load(snapshot.session);
    },
    setWriteListener: (next) => {
      listener = next;
    },
  };
};

/**
 * Gives `navigator.serviceWorker` a harmless face: in a sandbox even reading it
 * throws, and the app's own code (and web-push helpers) read it freely.
 * Registration always rejects and `ready` never settles, which is exactly how an
 * unsupported browser behaves for the app's `.catch` handlers.
 */
export const installServiceWorkerStub = (win: Window = window): void => {
  const stub = {
    controller: null,
    ready: new Promise<never>(() => undefined),
    register: () => Promise.reject(new Error('Service workers are not available in a Remote tab')),
    getRegistration: () => Promise.resolve(undefined),
    getRegistrations: () => Promise.resolve([]),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
    startMessages: () => undefined,
  };
  Object.defineProperty(win.navigator, 'serviceWorker', { configurable: true, enumerable: true, get: () => stub });
};
