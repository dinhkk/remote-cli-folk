/** In-memory pair lock for tests that never open a database. */

import type { PairLockStore } from '../../pairing/pair-lock-store.js';

export const memoryPairLockStore = (initial = 0): PairLockStore => {
  let lockedUntil = initial;
  return {
    read: () => lockedUntil,
    write: (until) => {
      lockedUntil = until;
    },
  };
};
