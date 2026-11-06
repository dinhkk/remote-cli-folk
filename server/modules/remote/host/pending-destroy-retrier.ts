/**
 * Keeps trying to destroy the relay room of a revoked Host pairing until the relay confirms (AC-11,
 * contracts section 8): a revoke while the relay is unreachable leaves `{roomId, hostToken}` sealed in the
 * store, and this retrier asks again every 5 minutes. After 30 days it gives up and drops the record:
 * the relay forgets a room without activity after the same time, so nothing is left to destroy.
 *
 * It never overlaps itself: a run still waiting on the relay makes the next tick a no-op.
 */

import type { RemoteClock, RemotePairingStore } from '@/shared/types.js';

import { systemClock } from '../pairing/pairing-clock.js';

import type { RelayDestroyClient } from './relay-destroy-client.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export type PendingDestroyRetrierOptions = {
  store: Pick<RemotePairingStore, 'listPendingDestroy' | 'clearPendingDestroy' | 'getPairing'>;
  destroyClient: RelayDestroyClient;
  /** The saved `RELAY_SECRET`, or null (nothing can be done until one is saved). */
  getRelaySecret(): string | null;
  clock?: RemoteClock;
  intervalMs?: number;
  maxAgeMs?: number;
};

/**
 * Creates the retrier.
 * Consumed by: Host accept (the immediate attempt on revoke) and the Remote runtime (periodic retries).
 */
export function createPendingDestroyRetrier(options: PendingDestroyRetrierOptions) {
  const { store, destroyClient } = options;
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let running = false;
  let cancelTimer: (() => void) | undefined;
  let stopped = true;

  /** One attempt for one pairing; true when the relay confirmed (or the record was too old to matter). */
  const attempt = async (id: string, roomId: string, hostToken: string): Promise<boolean> => {
    const record = store.getPairing(id);
    // No pairing row: there is no relay URL to ask and no age to wait for, so the record can only be dropped.
    if (!record || (record.revokedAt != null && clock.now() - record.revokedAt > maxAgeMs)) {
      store.clearPendingDestroy(id);
      return true;
    }
    const relaySecret = options.getRelaySecret();
    if (!relaySecret) return false;
    const outcome = await destroyClient.destroy({ relayUrl: record.relayUrl, relaySecret, roomId, hostToken });
    if (outcome !== 'confirmed') return false;
    store.clearPendingDestroy(id);
    return true;
  };

  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      let confirmed = 0;
      for (const pending of store.listPendingDestroy()) {
        if (await attempt(pending.id, pending.roomId, pending.hostToken)) confirmed += 1;
      }
      return confirmed;
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    cancelTimer = clock.setTimer(() => {
      cancelTimer = undefined;
      void runOnce()
        .catch(() => undefined) // a database or relay failure must not stop the schedule
        .finally(() => {
          if (!stopped) schedule();
        });
    }, intervalMs);
  };

  return {
    /** One immediate attempt for a freshly revoked pairing; true when the relay confirmed. */
    async destroyNow(id: string): Promise<boolean> {
      const pending = store.listPendingDestroy().find((entry) => entry.id === id);
      if (!pending) return true;
      return attempt(pending.id, pending.roomId, pending.hostToken);
    },
    runOnce,
    start(): void {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop(): void {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

export type PendingDestroyRetrier = ReturnType<typeof createPendingDestroyRetrier>;
