import { appConfigDb } from '../../database/index.js';

const EPOCH_KEY = 'auth.token_epoch';

const listeners = new Set<(epoch: number) => void>();

/**
 * Current auth epoch: a counter stored in app_config that "log out everywhere" increments.
 * Remote tab tokens are derived from it, so bumping it invalidates them (and tells Remote
 * to close its open streams) even when the main JWT secret is pinned by env.
 */
export function getAuthEpoch(): number {
  const stored = Number.parseInt(appConfigDb.get(EPOCH_KEY) ?? '0', 10);
  return Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
}

/** Increments the epoch, persists it, notifies listeners once, and returns the new value. */
export function bumpAuthEpoch(): number {
  const next = getAuthEpoch() + 1;
  appConfigDb.set(EPOCH_KEY, String(next));
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch (error) {
      // One failing listener (e.g. a stream that is already gone) must not stop the others.
      console.error('[auth] epoch listener failed:', error instanceof Error ? error.message : String(error));
    }
  }
  return next;
}

/** Subscribes to epoch changes; returns the unsubscribe function. */
export function onAuthEpochChange(listener: (epoch: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
