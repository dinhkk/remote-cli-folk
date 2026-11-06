/**
 * Persistence of the Host's pairing lock (the 15 minutes after three wrong SAS entries).
 *
 * The lock is stored as epoch milliseconds under `remote.pair_lock_until` in `app_config` through the
 * throwing remote config repository, so a server restart cannot clear it and an unreadable
 * database is never mistaken for "not locked".
 */

import { remoteConfigDb } from '@/modules/database/index.js';

const PAIR_LOCK_KEY = 'remote.pair_lock_until';

export type PairLockStore = {
  /** Epoch ms until which pairing is locked; 0 when there is no lock. Throws when the database cannot be read. */
  read(): number;
  write(lockedUntil: number): void;
};

// Consumed by: the Host pairing service (default lock store).
export const createConfigPairLockStore = (): PairLockStore => ({
  read() {
    const stored = remoteConfigDb.get(PAIR_LOCK_KEY);
    if (stored === null) return 0;
    const value = Number(stored);
    // A value that is not a plain number is corrupt, not a lock: it cannot be honoured, only ignored.
    return Number.isFinite(value) && value > 0 ? value : 0;
  },
  write(lockedUntil) {
    remoteConfigDb.set(PAIR_LOCK_KEY, String(Math.trunc(lockedUntil)));
  },
});
