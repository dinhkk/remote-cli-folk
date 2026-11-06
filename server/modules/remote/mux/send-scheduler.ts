/**
 * The single send queue of a link (contracts section 6).
 *
 * Everything leaves through one encrypt-and-transmit step, so the counter order of the secure
 * channel stays simple, but frames are not sent first-come-first-served:
 *  - each stream has its own FIFO queue, so order inside a stream never changes;
 *  - streams whose next frame is a small control frame (keys, permission responses, requests,
 *    cancels, pings) are served before streams whose next frame is bulk (body chunks, big
 *    messages), so an upload cannot delay a key press by more than the chunk already in flight;
 *  - within each class the streams take turns (round-robin), so three downloads share the link.
 *
 * The scheduler awaits every `send` before choosing the next frame: that is what gives the
 * priorities effect (a free-running secure-channel queue would just buffer everything in FIFO
 * order) and what turns a slow socket into queue growth that the stream layer can react to.
 */

export type SchedulerPriority = 'control' | 'bulk';

export type SendSchedulerOptions = {
  /** Encrypts and transmits one mux frame; the next frame is not chosen until it settles. */
  send(plaintext: Buffer): Promise<void> | void;
  /** A frame left the queue (it is now in flight): per-stream accounting for backpressure. */
  onDequeued?(streamId: number, bytes: number): void;
  /** `send` failed: the scheduler stopped and dropped its queues. */
  onError?(error: unknown): void;
};

export type SendScheduler = {
  enqueue(streamId: number, plaintext: Buffer, priority: SchedulerPriority): void;
  /** Drops what is still queued for a stream (not a frame already in flight). */
  purge(streamId: number): void;
  queuedBytes(streamId: number): number;
  /** Frames waiting for one stream (or reply key). */
  queuedFrames(streamId: number): number;
  /** Frames waiting in the queues (not the one in flight). */
  readonly pendingFrames: number;
  /** Bytes waiting in all queues (not the frame in flight). */
  readonly totalBytes: number;
  /** Streams that currently have queued frames; 0 when idle (leak check). */
  readonly trackedStreams: number;
  /** Resolves once nothing is queued or in flight (or the scheduler stopped). */
  drain(): Promise<void>;
  /** Drops everything and ignores later frames. */
  stop(): void;
};

type QueuedFrame = { plaintext: Buffer; priority: SchedulerPriority };
type StreamQueue = { frames: QueuedFrame[]; bytes: number };

// Consumed by: stream-table (one scheduler per link session).
export const createSendScheduler = ({ send, onDequeued, onError }: SendSchedulerOptions): SendScheduler => {
  const queues = new Map<number, StreamQueue>();
  /** Streams with queued frames, in the order they joined; `cursor` is whose turn comes next. */
  let ring: number[] = [];
  let cursor = 0;
  let pumping = false;
  let stopped = false;
  let pendingFrames = 0;
  let totalBytes = 0;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = (): void => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const dropAll = (): void => {
    queues.clear();
    ring = [];
    cursor = 0;
    pendingFrames = 0;
    totalBytes = 0;
  };

  const removeFromRing = (index: number): void => {
    ring.splice(index, 1);
    if (index < cursor) cursor -= 1;
    cursor = ring.length === 0 ? 0 : cursor % ring.length;
  };

  /**
   * Control-headed streams first, then bulk-headed ones, each scanned from the rotation cursor.
   *
   * Invariant the receiver relies on: opening frames (HTTP_REQ, WS_OPEN) are always 'control' and a
   * new stream joins the END of the ring, so among streams with a queued opening frame the one
   * created first is always chosen first (the receiver refuses ids <= the highest it has seen).
   * Anything that lets a later stream's opening frame overtake an earlier one breaks that rule;
   * the randomized test in `mux-hostile-peer.test.ts` guards it.
   */
  const pickNext = (): { streamId: number; frame: QueuedFrame } | undefined => {
    if (ring.length === 0) return undefined;
    let chosen = -1;
    for (const wanted of ['control', 'bulk'] as const) {
      for (let step = 0; step < ring.length; step += 1) {
        const index = (cursor + step) % ring.length;
        const head = (queues.get(ring[index]) as StreamQueue).frames[0];
        if (head.priority === wanted) {
          chosen = index;
          break;
        }
      }
      if (chosen >= 0) break;
    }
    const streamId = ring[chosen];
    const queue = queues.get(streamId) as StreamQueue;
    const frame = queue.frames.shift() as QueuedFrame;
    queue.bytes -= frame.plaintext.length;
    totalBytes -= frame.plaintext.length;
    pendingFrames -= 1;
    if (queue.frames.length === 0) {
      queues.delete(streamId);
      cursor = chosen;
      removeFromRing(chosen);
    } else {
      cursor = (chosen + 1) % ring.length;
    }
    return { streamId, frame };
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (!stopped) {
        const next = pickNext();
        if (!next) break;
        onDequeued?.(next.streamId, next.frame.plaintext.length);
        try {
          await send(next.frame.plaintext);
        } catch (error) {
          stopped = true;
          dropAll();
          onError?.(error);
        }
      }
    } finally {
      pumping = false;
      settleIdle();
    }
  };

  return {
    enqueue(streamId, plaintext, priority) {
      if (stopped) return;
      let queue = queues.get(streamId);
      if (!queue) {
        queue = { frames: [], bytes: 0 };
        queues.set(streamId, queue);
        ring.push(streamId);
      }
      queue.frames.push({ plaintext, priority });
      queue.bytes += plaintext.length;
      totalBytes += plaintext.length;
      pendingFrames += 1;
      void pump();
    },

    purge(streamId) {
      const queue = queues.get(streamId);
      if (!queue) return;
      pendingFrames -= queue.frames.length;
      totalBytes -= queue.bytes;
      queues.delete(streamId);
      removeFromRing(ring.indexOf(streamId));
    },

    queuedBytes: (streamId) => queues.get(streamId)?.bytes ?? 0,

    queuedFrames: (streamId) => queues.get(streamId)?.frames.length ?? 0,

    get pendingFrames() {
      return pendingFrames;
    },

    get totalBytes() {
      return totalBytes;
    },

    get trackedStreams() {
      return queues.size;
    },

    drain() {
      if (!pumping && pendingFrames === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },

    stop() {
      stopped = true;
      dropAll();
      if (!pumping) settleIdle();
    },
  };
};
