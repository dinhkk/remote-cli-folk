/**
 * Idle expiry of pairings (FR-40, AC-29): a pairing with no activity for `idleDays` (default 30, 0 = never)
 * is expired: its key K is erased, the Controller cannot reconnect and reads `expired`, and the user pairs
 * again. Activity is real use (`last_activity_at`): on the Host a Controller that completed the K handshake or
 * sent traffic; on the Controller a tab or proxied request (a tab token), or a session that such use opened.
 * Merely listing the Hosts in Settings opens their links but renews nothing. A pairing without any activity
 * counts from its creation.
 *
 * Two triggers share the rule: a periodic sweep (every hour) and the check made when a pairing is used (the
 * Controller's `enforce` at connect/attach time, the Host's `isIdleExpired` while syncing links), so a
 * pairing is never served after its limit even if the sweep has not run yet. All time comes from the
 * injected clock.
 *
 * Host pairings also need their link torn down and the relay room destroyed: that stays with the Host accept
 * service (`expireHostPairings`), which owns the links. A Controller pairing is handled here.
 * The 30-day window of a pair CODE (single use) is a different thing and lives with the pairing ceremony.
 */

import type { RemoteClock, RemotePairingRecord, RemotePairingStore } from '@/shared/types.js';

export const DEFAULT_PAIRING_IDLE_DAYS = 30;
const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 3_600_000;

export type PairingExpiryOptions = {
  store: Pick<RemotePairingStore, 'listPairings' | 'getPairing' | 'expirePairing'>;
  clock: RemoteClock;
  /** Days without activity before a pairing expires; 0 turns expiry off. */
  idleDays?: number;
  /** A Controller pairing was expired (close its link and browser connections). */
  onControllerExpired?(record: RemotePairingRecord): void;
  /** Expire the Host pairings that are idle (link teardown + relay DESTROY live with the Host accept service). Returns how many. */
  expireHostPairings?(): number;
  /** A pairing was expired by the Controller path (audit/diagnostics). */
  onExpired?(record: RemotePairingRecord): void;
};

/** The idle limit in days from an environment value: unset or invalid = 30, 0 = off. */
export const resolveIdleDays = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') return DEFAULT_PAIRING_IDLE_DAYS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PAIRING_IDLE_DAYS;
};

/**
 * Creates the idle-expiry service.
 * Consumed by: the Remote runtime (Host accept, peer registry, periodic job).
 */
export function createPairingExpiryService(options: PairingExpiryOptions) {
  const { store, clock } = options;
  const idleMs = Math.max(0, options.idleDays ?? DEFAULT_PAIRING_IDLE_DAYS) * DAY_MS;
  let cancelSweep: (() => void) | undefined;

  /** True for a live (not revoked, not yet expired) pairing whose last activity is older than the limit. */
  const isIdleExpired = (record: RemotePairingRecord): boolean => {
    if (idleMs === 0 || record.revokedAt !== null || record.expiresAt !== null) return false;
    // `last_connected_at` is deliberately not a fallback: a link a Settings list opened by itself records it
    // without renewing activity, and must not keep the pairing alive.
    const reference = record.lastActivityAt ?? record.createdAt;
    return clock.now() - reference >= idleMs;
  };

  const expireController = (record: RemotePairingRecord): RemotePairingRecord => {
    const expired = store.expirePairing(record.id);
    try {
      options.onControllerExpired?.(expired);
      options.onExpired?.(expired);
    } catch {
      // Closing the link is best effort: the key is already gone, so nothing can reconnect.
    }
    return expired;
  };

  const sweep = (): number => {
    let expired = 0;
    for (const record of store.listPairings('controller')) {
      if (!isIdleExpired(record)) continue;
      try {
        expireController(record);
        expired += 1;
      } catch {
        // One unreadable row must not stop the others; the next sweep tries again.
      }
    }
    try {
      expired += options.expireHostPairings?.() ?? 0;
    } catch {
      // see above
    }
    return expired;
  };

  const schedule = (): void => {
    cancelSweep = clock.setTimer(() => {
      sweep();
      schedule();
    }, SWEEP_INTERVAL_MS);
  };

  return {
    isIdleExpired,

    /**
     * The Controller's check when a pairing is about to be used: returns the record as it must be treated
     * now (an idle one is expired first, so its key is gone and it reads `expired`).
     */
    enforce(record: RemotePairingRecord): RemotePairingRecord {
      if (record.role !== 'controller' || !isIdleExpired(record)) return record;
      try {
        return expireController(record);
      } catch {
        return record; // cannot expire right now (database): the next use tries again
      }
    },

    sweep,

    /** One sweep now (leftovers of a stopped server), then one per hour. */
    start(): void {
      if (cancelSweep) return;
      sweep();
      schedule();
    },

    stop(): void {
      cancelSweep?.();
      cancelSweep = undefined;
    },
  };
}

export type PairingExpiryService = ReturnType<typeof createPairingExpiryService>;
