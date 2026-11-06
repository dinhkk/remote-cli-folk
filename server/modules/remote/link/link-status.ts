/**
 * The observable status of a relay link: state, UI peer state, reason, back-off attempt and the
 * scheduled retry. Changes are emitted as `state` events only when something actually differs.
 */

import type { RemoteLinkReason, RemoteLinkState, RemoteLinkStatus, RemotePeerState } from '@/shared/types.js';

import type { LinkEmitter } from './link-emitter.js';
import type { Backoff } from './reconnect-policy.js';

const PEER_STATES: Record<RemoteLinkState, RemotePeerState> = {
  stopped: 'offline',
  connecting: 'connecting',
  online: 'online',
  rejected: 'offline',
  locked: 'locked',
  replaced: 'replaced',
  revoked: 'revoked',
};

/** Link state -> UI peer state (contracts section 2). */
// Consumed by: the Controller proxy's `GET /peers` (phase 08).
export const toRemotePeerState = (state: RemoteLinkState): RemotePeerState => PEER_STATES[state];

export type LinkStatusTracker = {
  readonly current: RemoteLinkStatus;
  /** Publishes a new status (and the current back-off attempt) if anything changed. */
  set(state: RemoteLinkState, reason: RemoteLinkReason | null, retryInMs?: number | null): void;
};

// Consumed by: relay-link (one tracker per link).
export const createLinkStatus = (emitter: LinkEmitter, backoff: Backoff): LinkStatusTracker => {
  let status: RemoteLinkStatus = { state: 'stopped', peerState: 'offline', reason: null, attempt: 0, retryInMs: null };
  return {
    get current() {
      return status;
    },
    set(state, reason, retryInMs = null) {
      const next: RemoteLinkStatus = { state, peerState: toRemotePeerState(state), reason, attempt: backoff.attempt, retryInMs };
      if (next.state === status.state && next.reason === status.reason && next.attempt === status.attempt && next.retryInMs === status.retryInMs) return;
      status = next;
      emitter.emit('state', status);
    },
  };
};
