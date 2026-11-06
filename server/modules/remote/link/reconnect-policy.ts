/**
 * When and how a relay link retries (contracts section 4 close codes).
 *
 * - closes 4409 -> `replaced` and 4410 -> `revoked` are final;
 * - 4401, 4429 and HTTP 4xx/503 before the upgrade -> `rejected`/`locked`, retried after 60 s;
 * - everything else (including 4404 "no such Host room yet") is retried with back-off 1/2/5/10/30 s.
 *
 * The back-off counter only resets after something stayed up for `STABLE_MS`: a session for either
 * role, or (Host only) a relay connection that stayed `ready`. A flapping network therefore cannot
 * make a link hammer the relay, while a link that has been calm for a minute starts from one second
 * again after the next hiccup instead of staying at the 30 s ceiling.
 */

import type { RemoteLinkReason, RemoteLinkState } from '@/shared/types.js';

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
/** Retry delay after a refusal (401/4401, protocol mismatch) or a lock (4429). */
export const REFUSED_RETRY_MS = 60_000;
/** A session (or, for the Host, a relay connection) that lasted this long clears the back-off counter. */
export const STABLE_MS = 60_000;

export type CloseOutcome = { state: RemoteLinkState; reason: RemoteLinkReason; retryMs: number | 'backoff' | null };

/** What a socket close means for the link. */
// Consumed by: relay-link (every socket close).
export const classifyClose = (code: number, httpStatus: number | undefined): CloseOutcome => {
  if (httpStatus !== undefined) {
    const refused = (httpStatus >= 400 && httpStatus < 500) || httpStatus === 503;
    return refused
      ? { state: 'rejected', reason: 'relay-rejected', retryMs: REFUSED_RETRY_MS }
      : { state: 'connecting', reason: 'relay-unreachable', retryMs: 'backoff' };
  }
  switch (code) {
    case 4409:
      return { state: 'replaced', reason: 'replaced', retryMs: null };
    case 4410:
      return { state: 'revoked', reason: 'revoked', retryMs: null };
    case 4429:
      return { state: 'locked', reason: 'locked', retryMs: REFUSED_RETRY_MS };
    case 4401:
      return { state: 'rejected', reason: 'relay-rejected', retryMs: REFUSED_RETRY_MS };
    case 4404:
      return { state: 'connecting', reason: 'host-absent', retryMs: 'backoff' };
    default:
      return { state: 'connecting', reason: 'relay-unreachable', retryMs: 'backoff' };
  }
};

export type Backoff = {
  /** Consecutive failed attempts since the last reset. */
  readonly attempt: number;
  /** The next delay; every call counts as one more failed attempt. */
  next(): number;
  reset(): void;
};

// Consumed by: relay-link (one counter per link).
export const createBackoff = (): Backoff => {
  let attempt = 0;
  return {
    get attempt() {
      return attempt;
    },
    next() {
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      return delay;
    },
    reset() {
      attempt = 0;
    },
  };
};
