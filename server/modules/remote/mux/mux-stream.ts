/**
 * One multiplexed stream: its send API, receive rules, backpressure and teardown.
 *
 * A stream is HTTP (`HTTP_REQ` ... `RES_BODY`) or WebSocket (`WS_OPEN` ... `WS_CLOSE`). The side
 * that sent the opening frame is the "initiator". Every frame that arrives is checked against the
 * stream's kind, direction and order; a violation fails only this stream with `REMOTE_PROTOCOL`.
 *
 * Send queue and backpressure (contracts section 6): the bytes a stream still has waiting for the
 * link (scheduler queue plus the batching buffer) are compared with the limits: reaching the high
 * mark pauses the data source (`onPause`, writes return false), draining to the low mark resumes
 * it, and exceeding the maximum closes the stream (WS 1013 / ERROR). That close is a server-side
 * decision and is reported as `queue-overflow`, which is not a violation by the peer.
 */

import type {
  RemoteClock,
  RemoteErrorCode,
  RemoteMuxFrame,
  RemoteMuxLimits,
  RemoteMuxStream,
  RemoteStreamEnd,
  RemoteStreamHandlers,
} from '@/shared/types.js';

import { MAX_BODY_CHUNK_BYTES, MAX_WS_MESSAGE_BYTES, isValidWsCloseCode, splitBatchBody } from './frames.js';
import { createMessageBatcher } from './message-batcher.js';

const EMPTY = Buffer.alloc(0);
const MAX_CLOSE_REASON_CHARS = 120;
const MAX_ERROR_MESSAGE_CHARS = 1000;

/** What a stream needs from its table; keeps the stream free of table internals. */
export type StreamContext = {
  limits: RemoteMuxLimits;
  clock: RemoteClock;
  /** Host streams batch small WS messages (Host -> Controller only). */
  batching: boolean;
  enqueue(frame: RemoteMuxFrame): void;
  purge(streamId: number): void;
  queuedBytes(streamId: number): number;
  release(streamId: number): void;
  reportHandlerError(error: unknown): void;
};

/** The public stream plus the hooks the table drives. */
export type MuxStreamInternal = RemoteMuxStream & {
  /** A frame addressed to this stream arrived. */
  deliver(frame: RemoteMuxFrame): void;
  /** A frame of this stream left the send queue (it may be time to resume the source). */
  onDequeued(): void;
  /** The whole session ended: close without sending anything. */
  terminate(end: RemoteStreamEnd): void;
};

export type MuxStreamSpec = { id: number; kind: 'http' | 'ws'; initiator: boolean };

// Consumed by: stream-table (creates one per opened or incoming stream).
export const createMuxStream = (ctx: StreamContext, { id, kind, initiator }: MuxStreamSpec, initialHandlers: RemoteStreamHandlers): MuxStreamInternal => {
  let handlers = initialHandlers;
  let closed = false;
  let paused = false;
  let localFin = false;
  let remoteFin = false;
  let responseSent = false;
  let gotResponse = false;
  let requestBytes = 0;

  const batcher =
    ctx.batching && kind === 'ws'
      ? createMessageBatcher({
          clock: ctx.clock,
          windowMs: ctx.limits.batchWindowMs,
          emit: (meta, body) => ctx.enqueue({ type: 'WS_MSG', streamId: id, meta, body }),
        })
      : undefined;

  const queued = (): number => (closed ? 0 : ctx.queuedBytes(id) + (batcher?.pendingBytes ?? 0));

  /** Runs a handler; a throw is reported and fails the stream instead of breaking the link. */
  const call = (handler: () => void): void => {
    try {
      handler();
    } catch (error) {
      ctx.reportHandlerError(error);
      fail('REMOTE_INTERNAL', 'Stream handler failed.');
    }
  };

  const finish = (end: RemoteStreamEnd, purge: boolean): void => {
    if (closed) return;
    closed = true;
    paused = false;
    batcher?.discard();
    if (purge) ctx.purge(id);
    ctx.release(id);
    const { onClosed } = handlers;
    handlers = {};
    try {
      onClosed?.(end);
    } catch (error) {
      ctx.reportHandlerError(error);
    }
  };

  /** Local abort: drop what is queued, tell the peer, then close. The abort frame is queued after the purge. */
  const abort = (frame: RemoteMuxFrame, end: RemoteStreamEnd): void => {
    if (closed) return;
    ctx.purge(id);
    ctx.enqueue(frame);
    finish(end, false);
  };

  const fail = (code: RemoteErrorCode, requestedMessage: string): void => {
    const message = requestedMessage.slice(0, MAX_ERROR_MESSAGE_CHARS);
    abort({ type: 'ERROR', streamId: id, meta: { code, message }, body: EMPTY }, { cause: 'error', origin: 'local', code, message });
  };

  const overflow = (): void =>
    abort(
      kind === 'ws'
        ? { type: 'WS_CLOSE', streamId: id, meta: { code: 1013, reason: 'queue overflow' }, body: EMPTY }
        : { type: 'ERROR', streamId: id, meta: { code: 'REMOTE_INTERNAL', message: 'Stream queue overflow.' }, body: EMPTY },
      { cause: 'queue-overflow' },
    );

  /**
   * Applies the queue limits after something was queued. False when the stream is gone: it just
   * overflowed, the link-wide cap failed it, or `onPause` cancelled it (the caller must stop writing).
   */
  const checkQueue = (): boolean => {
    if (closed) return false;
    const bytes = queued();
    if (bytes > ctx.limits.maxQueuedBytes) {
      overflow();
      return false;
    }
    if (!paused && bytes >= ctx.limits.pauseHighWaterBytes) {
      paused = true;
      call(() => handlers.onPause?.());
    }
    return !closed;
  };

  const maybeComplete = (): void => {
    if (kind === 'http' && localFin && remoteFin) finish({ cause: 'completed' }, false);
  };

  const closeWebSocket = (requestedCode: number, requestedReason: string): void => {
    if (closed || kind !== 'ws') return;
    // Values the wire format would refuse (reserved codes such as 1005/1006, long reasons) must not leave the stream half-closed.
    const code = isValidWsCloseCode(requestedCode) ? requestedCode : 1011;
    const reason = requestedReason.slice(0, MAX_CLOSE_REASON_CHARS);
    batcher?.flush();
    ctx.enqueue({ type: 'WS_CLOSE', streamId: id, meta: { code, reason }, body: EMPTY });
    finish({ cause: 'local-ws-close', code, reason }, false);
  };

  const protocolError = (message: string): void => fail('REMOTE_PROTOCOL', message);

  const deliver = (frame: RemoteMuxFrame): void => {
    if (closed) return;
    switch (frame.type) {
      case 'HTTP_RES':
        if (kind !== 'http' || !initiator || gotResponse) return protocolError('Unexpected response head.');
        gotResponse = true;
        return call(() => handlers.onResponse?.(frame.meta));
      case 'REQ_BODY':
        if (kind !== 'http' || initiator || remoteFin) return protocolError('Unexpected request body.');
        requestBytes += frame.body.length;
        if (requestBytes > ctx.limits.maxRequestBodyBytes) return fail('REMOTE_TOO_LARGE', 'Request body exceeds the limit.');
        remoteFin = frame.meta.fin;
        call(() => handlers.onBody?.(frame.body, frame.meta.fin));
        return maybeComplete();
      case 'RES_BODY':
        if (kind !== 'http' || !initiator || !gotResponse || remoteFin) return protocolError('Unexpected response body.');
        remoteFin = frame.meta.fin;
        call(() => handlers.onBody?.(frame.body, frame.meta.fin));
        return maybeComplete();
      case 'WS_MSG': {
        if (kind !== 'ws') return protocolError('Unexpected WebSocket message.');
        const messages = frame.meta.batch === undefined ? [frame.body] : splitBatchBody(frame.body, frame.meta.batch);
        for (const message of messages) {
          if (closed) return;
          call(() => handlers.onMessage?.(message, frame.meta.binary));
        }
        return;
      }
      case 'WS_CLOSE':
        if (kind !== 'ws') return protocolError('Unexpected WebSocket close.');
        return finish({ cause: 'peer-ws-close', code: frame.meta.code, reason: frame.meta.reason }, true);
      case 'CANCEL':
        return finish({ cause: 'peer-cancel' }, true);
      case 'ERROR':
        return finish({ cause: 'error', origin: 'peer', code: frame.meta.code, message: frame.meta.message }, true);
      default:
        // A second opening frame, or a connection-level frame on a stream.
        return protocolError('Unexpected frame for this stream.');
    }
  };

  return {
    id,
    kind,
    get closed() {
      return closed;
    },
    get queuedBytes() {
      return queued();
    },
    get paused() {
      return paused;
    },

    setHandlers(next) {
      if (!closed) handlers = next;
    },

    sendResponse(meta) {
      if (closed || kind !== 'http' || initiator || responseSent) return;
      responseSent = true;
      ctx.enqueue({ type: 'HTTP_RES', streamId: id, meta, body: EMPTY });
    },

    writeBody(chunk, fin = false) {
      if (closed || kind !== 'http' || localFin) return false;
      if (chunk.length === 0 && !fin) return !paused;
      const type = initiator ? 'REQ_BODY' : 'RES_BODY';
      const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      do {
        const end = Math.min(offset + MAX_BODY_CHUNK_BYTES, data.length);
        ctx.enqueue({ type, streamId: id, meta: { fin: fin && end >= data.length }, body: data.subarray(offset, end) });
        offset = end;
        if (!checkQueue()) return false;
      } while (offset < data.length);
      if (fin) {
        localFin = true;
        maybeComplete();
      }
      return !paused && !closed;
    },

    sendMessage(payload, binary) {
      if (closed || kind !== 'ws') return false;
      if (payload.length > MAX_WS_MESSAGE_BYTES) {
        closeWebSocket(1009, 'message too big');
        return false;
      }
      const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      if (batcher) batcher.push(data, binary);
      else ctx.enqueue({ type: 'WS_MSG', streamId: id, meta: { binary }, body: data });
      return checkQueue() && !paused;
    },

    closeWebSocket,

    cancel() {
      abort({ type: 'CANCEL', streamId: id, meta: {}, body: EMPTY }, { cause: 'local-cancel' });
    },

    fail,

    deliver,

    onDequeued() {
      if (paused && !closed && queued() <= ctx.limits.resumeLowWaterBytes) {
        paused = false;
        call(() => handlers.onResume?.());
      }
    },

    terminate(end) {
      finish(end, true);
    },
  };
};
