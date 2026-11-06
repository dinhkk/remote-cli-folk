/** Small helpers shared by the mux and link tests. */

import type { RemoteMuxFrame, RemoteMuxStream, RemoteStreamHandlers } from '@/shared/types.js';

const EMPTY = Buffer.alloc(0);

/** Builds raw plaintext bytes without the codec so tests can make frames the codec would refuse. */
export const rawFrame = (type: number, streamId: number, meta: unknown, body: Uint8Array = EMPTY, metaBytes?: Buffer): Buffer => {
  const metaBuffer = metaBytes ?? Buffer.from(JSON.stringify(meta), 'utf8');
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeUInt32BE(streamId, 1);
  header.writeUInt32BE(metaBuffer.length, 5);
  return Buffer.concat([header, metaBuffer, body]);
};

/**
 * What a well-behaved data source does with the stream's pause/resume signals: stop writing while
 * paused, continue when resumed. `handlers` goes into `openStream` / `setHandlers`.
 */
export const createFlowControl = () => {
  let waiter: (() => void) | undefined;
  const wake = () => {
    const resolve = waiter;
    waiter = undefined;
    resolve?.();
  };
  const counters = { pauses: 0, resumes: 0, queuedAtPause: [] as number[], queuedAtResume: [] as number[], maxQueued: 0 };
  return {
    counters,
    handlers: (stream: () => RemoteMuxStream | undefined): RemoteStreamHandlers => ({
      onPause: () => {
        counters.pauses += 1;
        counters.queuedAtPause.push(stream()?.queuedBytes ?? -1);
      },
      onResume: () => {
        counters.resumes += 1;
        counters.queuedAtResume.push(stream()?.queuedBytes ?? -1);
        wake();
      },
      onClosed: wake,
    }),
    /** Resolves when the stream may take more data (immediately if it is not paused). */
    async untilWritable(stream: RemoteMuxStream): Promise<void> {
      counters.maxQueued = Math.max(counters.maxQueued, stream.queuedBytes);
      while (stream.paused && !stream.closed) await new Promise<void>((resolve) => (waiter = resolve));
    },
  };
};

export const framesOfType = <T extends RemoteMuxFrame['type']>(frames: RemoteMuxFrame[], type: T): Array<RemoteMuxFrame<T>> =>
  frames.filter((frame) => frame.type === type) as Array<RemoteMuxFrame<T>>;
