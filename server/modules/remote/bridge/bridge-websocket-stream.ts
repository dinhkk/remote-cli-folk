/**
 * WebSocket half of the Host bridge: one mux WS stream -> one loopback WebSocket to `/ws` or `/shell`.
 *
 * Only those two paths are served; every Controller message is checked by the WS message policy
 * (anything outside the list closes the stream with 4403 and is reported); `rememberEntry` is dropped
 * from permission responses. Neither the query (the tab token) nor the subprotocol (where the tab token
 * also travels) is forwarded.
 *
 * Backpressure: toward the Controller the loopback socket is paused while the stream's queue is above
 * the high-water mark (`onPause`/`onResume`); toward the Host the mux has no flow control, so the bytes
 * the loopback socket still holds (`bufferedAmount`) are capped (`maxUpstreamBufferedBytes`) and the
 * stream is cancelled with `REMOTE_QUOTA` past it. Messages sent before the loopback socket opens are
 * held in order, bounded by count and bytes (close 1013 beyond that).
 */

import type { WebSocket } from 'ws';

import type { RemoteMuxMeta, RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import { MAX_WS_MESSAGE_BYTES } from '../mux/frames.js';
import { evaluateRemoteWebSocketTarget } from '../policy/route-allow-list.js';
import { inspectControllerWsMessage } from '../policy/ws-message-policy.js';

import { createApprovalTracker } from './bridge-approval-audit.js';
import { MAX_PENDING_WEBSOCKET_MESSAGES, WS_OVERLOAD_CLOSE, WS_POLICY_CLOSE } from './bridge-limits.js';
import { describeTarget, sendableCloseCode, toBuffer, type BridgeContext, type StreamLifecycle } from './bridge-context.js';

/**
 * Serves one WebSocket stream the Controller opened. Installs the stream's handlers synchronously (or
 * refuses the stream right away). Consumed by: `createHostBridge`.
 */
export function bridgeWebSocketStream(
  context: BridgeContext,
  stream: RemoteMuxStream,
  meta: RemoteMuxMeta['WS_OPEN'],
  lifecycle: StreamLifecycle,
): void {
  const { client, limits, active, report } = context;
  const decision = evaluateRemoteWebSocketTarget(meta.path);
  if (!decision.allowed) {
    report({ kind: 'websocket-open', reason: decision.detail ?? decision.reason, target: describeTarget(meta.path) });
    stream.closeWebSocket(WS_POLICY_CLOSE, 'WebSocket path not allowed.');
    return;
  }
  const { channel, path } = decision;

  let upstream: WebSocket;
  try {
    upstream = client.openWebSocket({ path, handshakeTimeoutMs: limits.websocketHandshakeMs, maxPayloadBytes: MAX_WS_MESSAGE_BYTES });
  } catch {
    stream.fail('REMOTE_INTERNAL', 'The Host loopback is unavailable.');
    return;
  }

  let done = false;
  let opened = false;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  // Approval decisions are audited from the chat socket; the terminal socket is audited as PTY open/close.
  const approvals = channel === 'chat' ? createApprovalTracker(context.audit) : undefined;
  const openedAt = Date.now();
  if (channel === 'shell') context.audit({ event: 'pty-open', target: path, result: 'ok' });

  const cleanup = (end: RemoteStreamEnd): void => {
    done = true;
    pending = [];
    active.delete(stream);
    if (channel === 'shell') {
      context.audit({ event: 'pty-close', target: path, result: 'closed', detail: { seconds: Math.round((Date.now() - openedAt) / 1000) } });
    }
    lifecycle.ended(end);
    try {
      if (end.cause === 'peer-ws-close' && upstream.readyState === upstream.OPEN) upstream.close(sendableCloseCode(end.code));
      else upstream.terminate();
    } catch {
      upstream.terminate();
    }
  };
  const send = (message: Buffer): void => {
    upstream.send(message, { binary: false }, () => undefined);
    if (upstream.bufferedAmount > limits.maxUpstreamBufferedBytes && !stream.closed) {
      stream.fail('REMOTE_QUOTA', 'The Host is not reading WebSocket messages fast enough.');
    }
  };

  active.add(stream);
  stream.setHandlers({
    onMessage: (payload, binary) => {
      if (done) return;
      const verdict = inspectControllerWsMessage(channel, payload, binary);
      if (!verdict.ok) {
        report({ kind: 'websocket-message', reason: verdict.reason, target: path });
        stream.closeWebSocket(WS_POLICY_CLOSE, 'Message not allowed.');
        return;
      }
      const message = Buffer.from(verdict.payload.buffer, verdict.payload.byteOffset, verdict.payload.byteLength);
      approvals?.observeController(message);
      if (opened) {
        send(message);
        return;
      }
      // The loopback upgrade is still in flight: keep order, bounded.
      pendingBytes += message.length;
      if (pending.length >= MAX_PENDING_WEBSOCKET_MESSAGES || pendingBytes > limits.maxPendingWebSocketBytes) {
        stream.closeWebSocket(WS_OVERLOAD_CLOSE, 'Too many messages while connecting.');
        return;
      }
      pending.push(message);
    },
    onPause: () => upstream.pause(),
    onResume: () => upstream.resume(),
    onClosed: cleanup,
  });

  upstream.on('open', () => {
    if (done) return;
    opened = true;
    for (const message of pending) send(message);
    pending = [];
    pendingBytes = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (done) return;
    const message = toBuffer(data);
    approvals?.observeHost(message, isBinary);
    if (!stream.sendMessage(message, isBinary) && !stream.closed) upstream.pause();
  });
  upstream.on('unexpected-response', (_request, response) => {
    response.resume();
    if (done) return;
    const status = response.statusCode ?? 502;
    stream.fail(status === 401 || status === 403 ? 'REMOTE_UPSTREAM_AUTH' : 'REMOTE_INTERNAL', `The Host refused the WebSocket (${status}).`);
  });
  upstream.on('close', (code, reason) => {
    if (done) return;
    if (!opened) stream.fail('REMOTE_INTERNAL', 'The Host WebSocket could not be opened.');
    else stream.closeWebSocket(sendableCloseCode(code), reason.toString('utf8'));
  });
  // 'close' always follows an 'error'; listening keeps it from being thrown as an unhandled event.
  upstream.on('error', () => undefined);
}
