/**
 * What the HTTP and WebSocket halves of the Host bridge share: the loopback client, the limits, the set
 * of active streams, the violation reporter, and the small formatting helpers both use.
 */

import type { RawData } from 'ws';

import type { RemoteAuditEvent, RemoteBridgeViolation, RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import type { RemoteHttpPolicy } from '../policy/route-allow-list.js';

import type { HostBridgeLimits } from './bridge-limits.js';
import type { LoopbackClient } from './loopback-client.js';

/** The bridge's state as seen by one stream handler. `report` already applies the link's rate limit. */
// Consumed by: bridge-http-stream, bridge-websocket-stream (built by host-bridge).
export type BridgeContext = {
  client: LoopbackClient;
  /** The HTTP route policy (the production table unless a test injected another). */
  evaluateHttp: RemoteHttpPolicy;
  limits: HostBridgeLimits;
  /** Streams being served; a handler adds its stream and removes it when the stream closes. */
  active: Set<RemoteMuxStream>;
  report(violation: RemoteBridgeViolation): void;
  /** Hands an audit event to the bridge's owner; never throws. */
  audit(event: RemoteAuditEvent): void;
};

/** Told by a stream handler when its stream is gone (the quota slot is freed there). Idempotent. */
// Consumed by: bridge-http-stream, bridge-websocket-stream (built by bridge-admission).
export type StreamLifecycle = {
  ended(end?: RemoteStreamEnd): void;
};

/** Short, printable form of a target for reports: path only (no query), cut, non-printable characters replaced. */
export const describeTarget = (raw: string): string => String(raw).split('?', 1)[0].slice(0, 200).replace(/[^\x20-\x7e]/g, '?');

/** Close codes that may legally go on the wire; the rest (1005, 1006, 1015, reserved ranges) become 1000/1011. */
export const sendableCloseCode = (code: number): number => {
  if (code === 1005) return 1000;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
};

export const toBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};
