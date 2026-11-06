/**
 * Host -> Controller WS_MSG batching for one stream (contracts section 6).
 *
 * Terminal output arrives as many tiny messages; sending each as its own encrypted frame wastes
 * relay requests. Small messages are therefore collected for a short window and sent as one
 * WS_MSG whose body is an array of length-prefixed items (never concatenated text, so every
 * message boundary survives). Order inside the stream is sacred, so the pending batch is flushed
 * BEFORE anything that must not overtake or be overtaken: a large message, a change between text
 * and binary, a WS_CLOSE (the stream calls `flush`). A batch also never grows past one body
 * chunk. The window is 50 ms by default, which also bounds a stream to ~20 batches per second.
 */

import type { RemoteClock, RemoteMuxMeta } from '@/shared/types.js';

import { MAX_BATCH_MESSAGES, MAX_BODY_CHUNK_BYTES, SMALL_MESSAGE_BYTES, encodeBatchBody } from './frames.js';

const ITEM_OVERHEAD_BYTES = 4;

export type MessageBatcherOptions = {
  clock: RemoteClock;
  windowMs: number;
  /** Receives each outgoing WS_MSG (meta + body) in send order. */
  emit(meta: RemoteMuxMeta['WS_MSG'], body: Buffer): void;
};

export type MessageBatcher = {
  /** Queues one message; may emit earlier messages first to keep order. */
  push(payload: Uint8Array, binary: boolean): void;
  /** Emits the pending batch now (no-op when nothing is pending). */
  flush(): void;
  /** Drops pending messages without sending them (stream cancelled). */
  discard(): void;
  /** Bytes held back (payloads plus per-item overhead): counted against the stream's queue. */
  readonly pendingBytes: number;
};

// Consumed by: mux-stream (Host side only; the Controller never batches).
export const createMessageBatcher = ({ clock, windowMs, emit }: MessageBatcherOptions): MessageBatcher => {
  let pending: Buffer[] = [];
  let pendingBinary = false;
  let pendingBytes = 0;
  let cancelTimer: (() => void) | undefined;

  const flush = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (pending.length === 0) return;
    const messages = pending;
    const binary = pendingBinary;
    pending = [];
    pendingBytes = 0;
    if (messages.length === 1) emit({ binary }, messages[0]);
    else emit({ binary, batch: messages.length }, encodeBatchBody(messages));
  };

  return {
    push(payload, binary) {
      if (payload.length > SMALL_MESSAGE_BYTES) {
        flush();
        emit({ binary }, Buffer.from(payload));
        return;
      }
      const cost = payload.length + ITEM_OVERHEAD_BYTES;
      // Also a count cap: the codec refuses a batch of more than MAX_BATCH_MESSAGES items (empty messages are tiny).
      if (pending.length > 0 && (binary !== pendingBinary || pendingBytes + cost > MAX_BODY_CHUNK_BYTES || pending.length >= MAX_BATCH_MESSAGES)) flush();
      pendingBinary = binary;
      // Copy: the caller may reuse its buffer before the window closes.
      pending.push(Buffer.from(payload));
      pendingBytes += cost;
      cancelTimer ??= clock.setTimer(flush, windowMs);
    },

    flush,

    discard() {
      cancelTimer?.();
      cancelTimer = undefined;
      pending = [];
      pendingBytes = 0;
    },

    get pendingBytes() {
      return pendingBytes;
    },
  };
};
