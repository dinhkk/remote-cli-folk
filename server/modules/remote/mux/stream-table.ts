/**
 * Stream table of one link session: opens and routes streams over the single send scheduler.
 *
 * Ids: the Controller opens odd streams, the Host even ones; stream 0 is the connection itself
 * (APP_HELLO, PING, PONG, a connection-level ERROR), handed to the link. Per side only two numbers
 * are kept to recognise stragglers of closed streams (the highest id seen from the peer and the
 * next own id), so a closed stream costs no memory.
 *
 * `receive` never throws for peer input: undecodable frames, unknown streams and rule violations
 * are answered with an ERROR (never to a CANCEL/ERROR, which would loop) or dropped.
 */

import type {
  RemoteClock,
  RemoteErrorCode,
  RemoteLinkReason,
  RemoteMuxFrame,
  RemoteMuxLimits,
  RemoteMuxMeta,
  RemoteMuxStream,
  RemotePairingRole,
  RemoteStreamHandlers,
  RemoteStreamOpen,
} from '@/shared/types.js';

import { MuxFrameError, decodeFrame, encodeFrame, isControlFrame } from './frames.js';
import { createMuxStream, type MuxStreamInternal, type StreamContext } from './mux-stream.js';
import { createSendScheduler } from './send-scheduler.js';

/**
 * Contracts section 6: 8 MiB queue, pause at 4 MiB, resume at 1 MiB, 25 MiB request body, 50 ms
 * batching. Per-link ceilings against a hostile authenticated peer (see `RemoteMuxLimits`): 64 open
 * peer-opened streams, 32 MiB queued across streams, 64 pending self-generated replies, 4 PINGs/s.
 */
export const DEFAULT_MUX_LIMITS: RemoteMuxLimits = {
  maxQueuedBytes: 8 * 1024 * 1024,
  pauseHighWaterBytes: 4 * 1024 * 1024,
  resumeLowWaterBytes: 1024 * 1024,
  maxRequestBodyBytes: 25 * 1024 * 1024,
  batchWindowMs: 50,
  maxOpenStreams: 64,
  maxTotalQueuedBytes: 32 * 1024 * 1024,
  maxPendingReplies: 64,
  maxPingsPerSecond: 4,
};

const EMPTY = Buffer.alloc(0);
const MAX_STREAM_ID = 0xffffffff;
const TYPE_CANCEL = 0x30;
const TYPE_ERROR = 0x31;
/**
 * Scheduler key shared by every reply the table generates for ids that have no stream (ERRORs for
 * bad or refused ids). One queue instead of one per attacker-chosen id, so its length can be capped.
 */
const REPLY_QUEUE = -1;

export type StreamTableOptions = {
  role: RemotePairingRole;
  /** Encrypts and sends one plaintext frame; the next one is not chosen until it settles. */
  transmit(plaintext: Buffer): Promise<void> | void;
  clock: RemoteClock;
  limits?: Partial<RemoteMuxLimits>;
  /** A peer-opened stream arrived: install handlers now; return an error code to refuse it. */
  onIncomingStream(stream: RemoteMuxStream, open: RemoteStreamOpen): RemoteErrorCode | void;
  /** A stream-0 frame arrived (APP_HELLO, PING, PONG, ERROR). */
  onConnectionFrame(frame: RemoteMuxFrame): void;
  /** `transmit` failed: the send queue stopped; the link must end the session. */
  onTransmitError(error: unknown): void;
  /** The link-wide byte ceiling is exceeded and failing the offending stream did not fix it (called once): end the session. */
  onLinkQuotaExceeded?(): void;
  /** A stream or connection handler threw (diagnostics). */
  onHandlerError?(error: unknown): void;
};

export type ConnectionFrameType = 'APP_HELLO' | 'PING' | 'PONG' | 'ERROR';

export type StreamTable = {
  /** Open streams (leak check). */
  readonly size: number;
  /** Frames waiting in the send queue (leak check). */
  readonly pendingFrames: number;
  /** Bytes waiting in the send queue across all streams (the link-wide ceiling applies to this). */
  readonly queuedBytes: number;
  /** Until enabled (after APP_HELLO), peer-opened streams are refused. Enabled by default. */
  acceptStreams(enabled: boolean): void;
  /** Opens a stream; throws `MuxFrameError` for invalid meta and `Error` when the table is closed. */
  openStream(open: RemoteStreamOpen, handlers: RemoteStreamHandlers): RemoteMuxStream;
  /** Feeds one decrypted frame. Never throws for peer input. */
  receive(plaintext: Uint8Array): void;
  sendConnectionFrame<T extends ConnectionFrameType>(type: T, meta: RemoteMuxMeta[T]): void;
  /** Resolves once the send queue is empty (used to let a final ERROR out before closing). */
  drain(): Promise<void>;
  /** Ends every stream with `link-down`, drops queued frames and refuses further use. */
  closeAll(reason: RemoteLinkReason): void;
};

// Consumed by: link-session (one table per established session) and the mux tests.
export const createStreamTable = (options: StreamTableOptions): StreamTable => {
  const { role, onIncomingStream, onConnectionFrame } = options;
  const limits: RemoteMuxLimits = { ...DEFAULT_MUX_LIMITS, ...options.limits };
  const streams = new Map<number, MuxStreamInternal>();
  // The peer's ids have the other parity: Controller odd, Host even.
  const peerParity = role === 'controller' ? 0 : 1;
  let nextLocalId = role === 'controller' ? 1 : 2;
  let highestPeerId = 0;
  let accepting = true;
  let closed = false;
  let enforcingQuota = false;
  let quotaReported = false;

  const scheduler = createSendScheduler({
    send: options.transmit,
    onDequeued: (streamId) => streams.get(streamId)?.onDequeued(),
    onError: options.onTransmitError,
  });

  /**
   * Link-wide byte ceiling, checked after every enqueue: the stream whose frame crossed it is failed
   * with REMOTE_QUOTA (its queue is purged, so the total falls back); only when nothing could be
   * failed (the bytes belong to no stream) is the whole session reported for teardown.
   */
  const enforceLinkQuota = (streamId: number): void => {
    // `fail` queues an ERROR through `enqueue` again; that nested call must not re-enter.
    if (enforcingQuota || scheduler.totalBytes <= limits.maxTotalQueuedBytes) return;
    enforcingQuota = true;
    try {
      streams.get(streamId)?.fail('REMOTE_QUOTA', 'Link queue limit exceeded.');
      if (scheduler.totalBytes > limits.maxTotalQueuedBytes && !quotaReported) {
        quotaReported = true;
        try {
          options.onLinkQuotaExceeded?.();
        } catch (error) {
          options.onHandlerError?.(error);
        }
      }
    } finally {
      enforcingQuota = false;
    }
  };

  const enqueue = (frame: RemoteMuxFrame): void => {
    scheduler.enqueue(frame.streamId, encodeFrame(frame), isControlFrame(frame.type, frame.body.length) ? 'control' : 'bulk');
    enforceLinkQuota(frame.streamId);
  };

  const context: StreamContext = {
    limits,
    clock: options.clock,
    batching: role === 'host',
    enqueue,
    purge: (streamId) => scheduler.purge(streamId),
    queuedBytes: (streamId) => scheduler.queuedBytes(streamId),
    release: (streamId) => {
      streams.delete(streamId);
    },
    reportHandlerError: (error) => options.onHandlerError?.(error),
  };

  const isPeerId = (id: number): boolean => id > 0 && id % 2 === peerParity;
  /** An id nobody has used yet: frames for it (other than an opening frame) are protocol violations. */
  const isUnusedId = (id: number): boolean => (isPeerId(id) ? id > highestPeerId : id >= nextLocalId);

  /**
   * Answers a frame for an id that has no stream. These replies are attacker-triggered, so they share
   * one bounded queue: past `maxPendingReplies` waiting replies the answer is dropped (the peer
   * gets silence, which costs this side nothing).
   */
  const sendError = (streamId: number, code: RemoteErrorCode, message: string): void => {
    if (scheduler.queuedFrames(REPLY_QUEUE) >= limits.maxPendingReplies) return;
    scheduler.enqueue(REPLY_QUEUE, encodeFrame({ type: 'ERROR', streamId, meta: { code, message }, body: EMPTY }), 'control');
    enforceLinkQuota(REPLY_QUEUE);
  };

  /** Refuses an opening frame; later frames of that id are stragglers (dropped) because the id counts as used. */
  const refuseOpening = (id: number, code: RemoteErrorCode, message: string): void => {
    if (isPeerId(id) && id > highestPeerId) highestPeerId = id;
    sendError(id, code, message);
  };

  const openIncoming = (frame: RemoteMuxFrame<'HTTP_REQ' | 'WS_OPEN'>): void => {
    const id = frame.streamId;
    // Only the Controller opens streams (the Host answers them): enforced here, not by whoever registered a handler.
    if (role === 'controller') return refuseOpening(id, 'REMOTE_PROTOCOL', 'This side does not accept streams.');
    if (!accepting) return sendError(id, 'REMOTE_PROTOCOL', 'Streams are not accepted yet.');
    if (!isPeerId(id) || id <= highestPeerId) return sendError(id, 'REMOTE_PROTOCOL', 'Invalid stream id.');
    if (streams.size >= limits.maxOpenStreams) return refuseOpening(id, 'REMOTE_QUOTA', 'Too many open streams.');
    highestPeerId = id;
    const open: RemoteStreamOpen =
      frame.type === 'HTTP_REQ' ? { kind: 'http', meta: frame.meta } : { kind: 'ws', meta: frame.meta };
    const stream = createMuxStream(context, { id, kind: open.kind, initiator: false }, {});
    streams.set(id, stream);
    let refusal: RemoteErrorCode | void;
    try {
      refusal = onIncomingStream(stream, open);
    } catch (error) {
      options.onHandlerError?.(error);
      refusal = 'REMOTE_INTERNAL';
    }
    if (refusal) stream.fail(refusal, 'Stream refused.');
  };

  const route = (frame: RemoteMuxFrame): void => {
    if (frame.streamId === 0) {
      try {
        onConnectionFrame(frame);
      } catch (error) {
        options.onHandlerError?.(error);
      }
      return;
    }
    const stream = streams.get(frame.streamId);
    if (stream) {
      stream.deliver(frame);
    } else if (frame.type === 'HTTP_REQ' || frame.type === 'WS_OPEN') {
      openIncoming(frame);
    } else if (frame.type !== 'CANCEL' && frame.type !== 'ERROR' && isUnusedId(frame.streamId)) {
      // Frames of streams that were closed meanwhile are stragglers and dropped; a never-used id is a violation.
      sendError(frame.streamId, 'REMOTE_PROTOCOL', 'Unknown stream.');
    }
  };

  const rejectUndecodable = (error: MuxFrameError): void => {
    const id = error.streamId;
    if (id === null || id === 0 || error.frameType === TYPE_CANCEL || error.frameType === TYPE_ERROR) return;
    const stream = streams.get(id);
    if (stream) stream.fail('REMOTE_PROTOCOL', `Invalid frame (${error.code}).`);
    else if (isUnusedId(id)) sendError(id, 'REMOTE_PROTOCOL', `Invalid frame (${error.code}).`);
  };

  return {
    get size() {
      return streams.size;
    },

    get pendingFrames() {
      return scheduler.pendingFrames;
    },

    get queuedBytes() {
      return scheduler.totalBytes;
    },

    acceptStreams(enabled) {
      accepting = enabled;
    },

    openStream(open, handlers) {
      if (closed) throw new Error('Stream table is closed.');
      const id = nextLocalId;
      if (id > MAX_STREAM_ID) throw new Error('Stream ids are exhausted; the session must be re-established.');
      // Encode first: invalid meta must fail before any state changes.
      const plaintext = encodeFrame(
        open.kind === 'http'
          ? { type: 'HTTP_REQ', streamId: id, meta: open.meta, body: EMPTY }
          : { type: 'WS_OPEN', streamId: id, meta: open.meta, body: EMPTY },
      );
      nextLocalId += 2;
      const stream = createMuxStream(context, { id, kind: open.kind, initiator: true }, handlers);
      streams.set(id, stream);
      scheduler.enqueue(id, plaintext, 'control');
      return stream;
    },

    receive(plaintext) {
      if (closed) return;
      let frame: RemoteMuxFrame;
      try {
        // Only the Host batches WS messages, so a batch from a Controller is a violation.
        frame = decodeFrame(plaintext, { peerRole: role === 'host' ? 'controller' : 'host' });
      } catch (error) {
        if (error instanceof MuxFrameError) return rejectUndecodable(error);
        throw error;
      }
      route(frame);
    },

    sendConnectionFrame(type, meta) {
      if (closed) return;
      // Anything already waiting on stream 0 reaches the peer first and proves liveness just as well: one pending reply is enough.
      if (type === 'PONG' && scheduler.queuedFrames(0) > 0) return;
      enqueue({ type, streamId: 0, meta, body: EMPTY } as RemoteMuxFrame);
    },

    drain: () => scheduler.drain(),

    closeAll(reason) {
      if (closed) return;
      closed = true;
      for (const stream of [...streams.values()]) stream.terminate({ cause: 'link-down', reason });
      streams.clear();
      scheduler.stop();
    },
  };
};
