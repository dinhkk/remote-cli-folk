/**
 * Admission of a Controller's stream at the Host bridge (FR-39): takes a slot in the pairing's quota (or
 * refuses the stream with `ERROR REMOTE_QUOTA`, HTTP 429 at the Controller, plus one audit row) and gives the
 * stream handler the `StreamLifecycle` that frees the slot when the stream ends.
 *
 * Which streams the server itself closed (overload 1013, queue overflow, a Host that does not read) is told
 * to the quota so the reconnect that follows is not counted as a violation.
 */

import type { RemoteAuditEvent, RemoteMuxStream, RemoteStreamEnd, RemoteStreamOpen, RemoteStreamQuota } from '@/shared/types.js';

import { evaluateRemoteWebSocketTarget } from '../policy/route-allow-list.js';

import { describeTarget, type StreamLifecycle } from './bridge-context.js';
import { WS_OVERLOAD_CLOSE } from './bridge-limits.js';

type AdmissionDeps = {
  quota?: RemoteStreamQuota;
  audit(event: RemoteAuditEvent): void;
  onActivity?: () => void;
};

/** Renewing the idle timer is bookkeeping; it never refuses a stream. */
const notifyActivity = (deps: AdmissionDeps): void => {
  try {
    deps.onActivity?.();
  } catch {
    // ignored on purpose
  }
};

/** A close the Host caused: not a sign of a misbehaving Controller. */
export const isServerCausedEnd = (end: RemoteStreamEnd | undefined): boolean =>
  end?.cause === 'queue-overflow' ||
  (end?.cause === 'local-ws-close' && end.code === WS_OVERLOAD_CLOSE) ||
  (end?.cause === 'error' && end.origin === 'local' && end.code === 'REMOTE_QUOTA');

/** `pty` = the terminal socket, `ws` = any other WebSocket (chat), `http` = a request. Unknown WebSocket paths count as `ws` (they are refused right after). */
const quotaKind = (open: RemoteStreamOpen): 'http' | 'ws' | 'pty' => {
  if (open.kind === 'http') return 'http';
  const decision = evaluateRemoteWebSocketTarget(open.meta.path);
  return decision.allowed && decision.channel === 'shell' ? 'pty' : 'ws';
};

const describeOpen = (open: RemoteStreamOpen): string =>
  open.kind === 'http' ? `${open.meta.method.slice(0, 16)} ${describeTarget(open.meta.path)}` : describeTarget(open.meta.path);

/**
 * Returns the lifecycle of an admitted stream, or null when the quota refused it (the stream is already
 * failed and reported). Consumed by: `createHostBridge`.
 */
export function admitBridgeStream(deps: AdmissionDeps, stream: RemoteMuxStream, open: RemoteStreamOpen): StreamLifecycle | null {
  const { quota } = deps;
  if (!quota) {
    notifyActivity(deps);
    return { ended: () => undefined };
  }
  const kind = quotaKind(open);
  const admission = quota.admit(kind);
  if (!admission.ok) {
    deps.audit({ event: 'quota-reject', target: describeOpen(open), result: 'refused', detail: { reason: admission.reason, kind } });
    stream.fail('REMOTE_QUOTA', `Per-pairing quota exceeded (${admission.reason}).`);
    return null;
  }
  notifyActivity(deps);
  let ended = false;
  return {
    ended(end) {
      if (ended) return;
      ended = true;
      admission.release();
      if (isServerCausedEnd(end)) quota.noteServerClose();
    },
  };
}
