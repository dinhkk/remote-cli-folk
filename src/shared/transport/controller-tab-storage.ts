import type { TabStorageArea, TabStorageSnapshot } from '@/shared/types';

/**
 * Where the Controller page keeps what a Remote tab stores (contracts.md sections 3 and 10).
 *
 * A sandboxed tab has no storage of its own; its `localStorage` writes arrive as
 * `storage-set` messages and land in the Controller's localStorage under
 * `remote:<peerId>:local:<key>`. Its `sessionStorage` writes are kept in memory
 * only (they live as long as the Controller page, like a session area should)
 * and are never persisted. The tab is untrusted code (it renders Host content),
 * so everything it may write is capped: per message, per tab and across all tabs
 * together, so no tab can fill the quota the Controller's own app needs. Sizes
 * are tracked in an in-memory ledger instead of rescanning localStorage on every
 * message.
 * Used by the Controller-side tab bridge, by the pairing UI (purge on forget or
 * revoke) and by the Local logout.
 */

export const REMOTE_STORAGE_PREFIX = 'remote:';

// What one tab may write. Lengths are UTF-16 code units of key + value.
const MAX_KEY_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_ENTRIES_PER_TAB = 200;
const MAX_TOTAL_PER_TAB = 256 * 1024;
const MAX_TOTAL_ALL_TABS = 1024 * 1024;

type Ledger = {
  /** Stored length (key + value) of every entry, durable or in memory. */
  sizes: Map<string, number>;
  /** Bytes and entry count per peer id. */
  perPeer: Map<string, { bytes: number; count: number }>;
  total: number;
};

// The session area of every tab: in memory, gone when the Controller page is.
const sessionEntries = new Map<string, string>();

// Null until first needed, and again after anything that changed storage behind its back (purge, quota error, a new snapshot).
let ledger: Ledger | null = null;

const isArea = (value: unknown): value is TabStorageArea => value === 'local' || value === 'session';
const areaPrefix = (peerId: string, area: TabStorageArea) => `${REMOTE_STORAGE_PREFIX}${peerId}:${area}:`;
// Peer ids never contain ':' (contracts section 2), so these are the second and third segments of a key.
const peerOf = (fullKey: string): string => fullKey.slice(REMOTE_STORAGE_PREFIX.length).split(':', 1)[0] ?? '';
const isSessionKey = (fullKey: string): boolean => fullKey.slice(REMOTE_STORAGE_PREFIX.length).split(':', 2)[1] === 'session';

const track = (current: Ledger, fullKey: string, size: number | null): void => {
  const peerId = peerOf(fullKey);
  const usage = current.perPeer.get(peerId) ?? { bytes: 0, count: 0 };
  const previous = current.sizes.get(fullKey);
  if (previous !== undefined) {
    usage.bytes -= previous;
    usage.count -= 1;
    current.total -= previous;
    current.sizes.delete(fullKey);
  }
  if (size !== null) {
    usage.bytes += size;
    usage.count += 1;
    current.total += size;
    current.sizes.set(fullKey, size);
  }
  if (usage.count > 0) current.perPeer.set(peerId, usage);
  else current.perPeer.delete(peerId);
};

const scanLedger = (): Ledger => {
  const fresh: Ledger = { sizes: new Map(), perPeer: new Map(), total: 0 };
  const legacySessionKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(REMOTE_STORAGE_PREFIX)) continue;
    // Older builds persisted the session area; it must not outlive the page.
    if (isSessionKey(key)) legacySessionKeys.push(key);
    else track(fresh, key, key.length + (localStorage.getItem(key)?.length ?? 0));
  }
  legacySessionKeys.forEach((key) => localStorage.removeItem(key));
  for (const [key, value] of sessionEntries) track(fresh, key, key.length + value.length);
  return fresh;
};

/**
 * What a tab starts with: its stored entries of both areas. Also refreshes the
 * ledger from the real storage, which keeps it honest when another window of the
 * Controller wrote in the meantime.
 */
export const readTabStorageSnapshot = (peerId: string): TabStorageSnapshot => {
  ledger = scanLedger();
  const snapshot: TabStorageSnapshot = { local: {}, session: {} };
  const localPrefix = areaPrefix(peerId, 'local');
  for (const fullKey of ledger.sizes.keys()) {
    if (!fullKey.startsWith(localPrefix)) continue;
    const value = localStorage.getItem(fullKey);
    if (value !== null) snapshot.local[fullKey.slice(localPrefix.length)] = value;
  }
  const sessionPrefix = areaPrefix(peerId, 'session');
  for (const [fullKey, value] of sessionEntries) {
    if (fullKey.startsWith(sessionPrefix)) snapshot.session[fullKey.slice(sessionPrefix.length)] = value;
  }
  return snapshot;
};

const removeEntry = (fullKey: string): void => {
  if (isSessionKey(fullKey)) sessionEntries.delete(fullKey);
  else localStorage.removeItem(fullKey);
};

/**
 * Applies one `storage-set` from a tab inside its namespace; anything outside the
 * caps, in the wrong shape or in another area is dropped silently. `key: null`
 * is `clear()` of one area; `value: null` removes one key.
 */
export const applyTabStorageWrite = (peerId: string, message: Record<string, unknown>): void => {
  const { area, key, value } = message;
  if (!isArea(area)) return;
  const prefix = areaPrefix(peerId, area);

  try {
    const current = (ledger ??= scanLedger());

    if (key === null) {
      for (const stored of [...current.sizes.keys()]) {
        if (!stored.startsWith(prefix)) continue;
        removeEntry(stored);
        track(current, stored, null);
      }
      return;
    }
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return;

    const fullKey = `${prefix}${key}`;
    if (value === null) {
      removeEntry(fullKey);
      track(current, fullKey, null);
      return;
    }
    if (typeof value !== 'string') return;

    const size = fullKey.length + value.length;
    if (size > MAX_MESSAGE_LENGTH) return;
    const previous = current.sizes.get(fullKey) ?? 0;
    const usage = current.perPeer.get(peerId) ?? { bytes: 0, count: 0 };
    if (previous === 0 && usage.count >= MAX_ENTRIES_PER_TAB) return;
    if (usage.bytes - previous + size > MAX_TOTAL_PER_TAB) return;
    if (current.total - previous + size > MAX_TOTAL_ALL_TABS) return;

    if (area === 'session') sessionEntries.set(fullKey, value);
    else localStorage.setItem(fullKey, value);
    track(current, fullKey, size);
  } catch {
    // Quota or a locked-down storage: the tab keeps working from its in-memory copy.
    ledger = null;
  }
};

/**
 * Deletes what Remote tabs stored: one peer's entries (pairing forgotten or
 * revoked), or all of them (Local logout). Nothing outside `remote:` is touched.
 */
export const purgeRemoteTabStorage = (peerId?: string): void => {
  const prefix = peerId ? `${REMOTE_STORAGE_PREFIX}${peerId}:` : REMOTE_STORAGE_PREFIX;
  for (const key of [...sessionEntries.keys()]) {
    if (key.startsWith(prefix)) sessionEntries.delete(key);
  }
  try {
    const doomed: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage unavailable: nothing was kept either.
  }
  ledger = null;
};
