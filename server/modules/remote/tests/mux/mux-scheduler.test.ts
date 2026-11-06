import assert from 'node:assert/strict';
import test from 'node:test';

import { createSendScheduler, type SchedulerPriority } from '../../mux/send-scheduler.js';
import { createSeededRandom } from '../support/seeded-random.js';

type Sent = { streamId: number; seq: number };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A frame whose first two bytes say which stream and sequence number it is. */
const frame = (streamId: number, seq: number, size = 16): Buffer => {
  const buffer = Buffer.alloc(size);
  buffer[0] = streamId;
  buffer[1] = seq & 0xff;
  buffer[2] = seq >> 8;
  return buffer;
};

/**
 * Scheduler whose `send` stays pending until the test lets it finish, which models the single
 * encrypt-and-transmit step of the link: while one frame is in flight, everything else queues.
 */
const createHarness = (gated = true) => {
  const sent: Sent[] = [];
  const waiting: Array<() => void> = [];
  const dequeued: Array<[number, number]> = [];
  const errors: unknown[] = [];
  let failNext: Error | undefined;
  const scheduler = createSendScheduler({
    send: (plaintext) => {
      sent.push({ streamId: plaintext[0], seq: plaintext[1] | (plaintext[2] << 8) });
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        return Promise.reject(error);
      }
      if (!gated) return undefined;
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    onDequeued: (streamId, bytes) => dequeued.push([streamId, bytes]),
    onError: (error) => errors.push(error),
  });
  const release = async (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      waiting.shift()?.();
      await tick();
    }
  };
  const releaseAll = async () => {
    while (waiting.length > 0) await release();
  };
  return { scheduler, sent, waiting, dequeued, errors, release, releaseAll, failOnNextSend: (error: Error) => (failNext = error) };
};

const order = (sent: Sent[]) => sent.map((entry) => `${entry.streamId}.${entry.seq}`);

/** Puts a frame in flight so everything enqueued afterwards is picked by the scheduler, not the idle fast path. */
const occupy = (harness: ReturnType<typeof createHarness>) => harness.scheduler.enqueue(0, frame(0, 0), 'control');

test('frames of one stream are sent in the order they were queued', async () => {
  const harness = createHarness(false);
  for (let seq = 0; seq < 20; seq += 1) harness.scheduler.enqueue(1, frame(1, seq), seq % 2 === 0 ? 'bulk' : 'control');
  await tick();
  assert.deepEqual(order(harness.sent), Array.from({ length: 20 }, (_, seq) => `1.${seq}`));
  assert.equal(harness.scheduler.pendingFrames, 0);
  assert.equal(harness.scheduler.trackedStreams, 0);
});

test('three bulk streams are served round-robin, one chunk each in turn', async () => {
  const harness = createHarness();
  occupy(harness);
  for (let seq = 0; seq < 4; seq += 1) {
    for (const streamId of [1, 2, 3]) harness.scheduler.enqueue(streamId, frame(streamId, seq), 'bulk');
  }
  await harness.release();
  await harness.releaseAll();
  assert.deepEqual(order(harness.sent), ['0.0', '1.0', '2.0', '3.0', '1.1', '2.1', '3.1', '1.2', '2.2', '3.2', '1.3', '2.3', '3.3']);
});

test('a small frame queued behind 25 MB of upload chunks goes out right after the chunk in flight', async () => {
  const harness = createHarness();
  const chunks = Math.ceil((25 * 1024 * 1024) / (64 * 1024));
  harness.scheduler.enqueue(1, frame(1, 0, 64), 'bulk'); // in flight
  for (let seq = 1; seq < chunks; seq += 1) harness.scheduler.enqueue(1, frame(1, seq, 64), 'bulk');
  // A permission response and a terminal key press arrive on other streams.
  harness.scheduler.enqueue(5, frame(5, 0), 'control');
  harness.scheduler.enqueue(7, frame(7, 0), 'control');
  await harness.release(4);
  assert.deepEqual(order(harness.sent).slice(0, 4), ['1.0', '5.0', '7.0', '1.1']);
  await harness.releaseAll();
  assert.equal(harness.sent.length, chunks + 2);
});

test('control frames of different streams alternate and keep priority over every bulk stream', async () => {
  const harness = createHarness();
  occupy(harness);
  for (let seq = 0; seq < 3; seq += 1) harness.scheduler.enqueue(1, frame(1, seq), 'bulk');
  for (let seq = 0; seq < 3; seq += 1) {
    harness.scheduler.enqueue(2, frame(2, seq), 'control');
    harness.scheduler.enqueue(3, frame(3, seq), 'control');
  }
  await harness.release();
  await harness.releaseAll();
  assert.deepEqual(order(harness.sent), ['0.0', '2.0', '3.0', '2.1', '3.1', '2.2', '3.2', '1.0', '1.1', '1.2']);
});

test('priority never reorders frames within a stream: a control frame waits behind its stream\'s bulk frame', async () => {
  const harness = createHarness();
  occupy(harness);
  harness.scheduler.enqueue(1, frame(1, 0), 'bulk'); // big WS message
  harness.scheduler.enqueue(1, frame(1, 1), 'control'); // small message after it: must stay behind
  harness.scheduler.enqueue(2, frame(2, 0), 'control');
  await harness.release();
  await harness.releaseAll();
  const sequence = order(harness.sent);
  assert.ok(sequence.indexOf('1.0') < sequence.indexOf('1.1'));
  assert.ok(sequence.indexOf('2.0') < sequence.indexOf('1.0'), 'other streams\' control frames still overtake the bulk head');
});

test('purge drops what is queued for a stream but not the frame already in flight', async () => {
  const harness = createHarness();
  harness.scheduler.enqueue(1, frame(1, 0, 100), 'bulk'); // in flight
  harness.scheduler.enqueue(1, frame(1, 1, 100), 'bulk');
  harness.scheduler.enqueue(1, frame(1, 2, 100), 'bulk');
  harness.scheduler.enqueue(2, frame(2, 0, 50), 'bulk');
  assert.equal(harness.scheduler.queuedBytes(1), 200);
  assert.equal(harness.scheduler.queuedBytes(2), 50);
  assert.equal(harness.scheduler.pendingFrames, 3);

  harness.scheduler.purge(1);
  assert.equal(harness.scheduler.queuedBytes(1), 0);
  assert.equal(harness.scheduler.pendingFrames, 1);
  harness.scheduler.purge(99); // unknown stream: no-op

  await harness.releaseAll();
  assert.deepEqual(order(harness.sent), ['1.0', '2.0']);
  assert.equal(harness.scheduler.trackedStreams, 0);
});

test('purging a stream in the middle of the rotation keeps the rotation fair', async () => {
  const harness = createHarness();
  occupy(harness);
  for (let seq = 0; seq < 3; seq += 1) for (const streamId of [1, 2, 3]) harness.scheduler.enqueue(streamId, frame(streamId, seq), 'bulk');
  await harness.release(); // 0.0 done, 1.0 in flight
  harness.scheduler.purge(2);
  await harness.releaseAll();
  assert.deepEqual(order(harness.sent), ['0.0', '1.0', '3.0', '1.1', '3.1', '1.2', '3.2']);
});

test('onDequeued reports every frame that leaves the queue with its size', async () => {
  const harness = createHarness();
  harness.scheduler.enqueue(4, frame(4, 0, 10), 'bulk');
  harness.scheduler.enqueue(4, frame(4, 1, 20), 'bulk');
  harness.scheduler.enqueue(6, frame(6, 0, 30), 'control');
  await harness.releaseAll();
  assert.deepEqual(harness.dequeued, [[4, 10], [6, 30], [4, 20]]);
});

test('drain resolves at once when idle and after the queue empties otherwise', async () => {
  const harness = createHarness();
  await harness.scheduler.drain();
  let drained = false;
  harness.scheduler.enqueue(1, frame(1, 0), 'bulk');
  harness.scheduler.enqueue(1, frame(1, 1), 'bulk');
  const waiter = harness.scheduler.drain().then(() => (drained = true));
  await tick();
  assert.equal(drained, false);
  await harness.releaseAll();
  await waiter;
  assert.equal(drained, true);
});

test('a failing send stops the scheduler, drops the queue and reports the error once', async () => {
  const harness = createHarness();
  harness.failOnNextSend(new Error('socket gone'));
  harness.scheduler.enqueue(1, frame(1, 0), 'bulk');
  harness.scheduler.enqueue(1, frame(1, 1), 'bulk');
  harness.scheduler.enqueue(2, frame(2, 0), 'control');
  await harness.scheduler.drain();
  assert.equal(harness.errors.length, 1);
  assert.equal((harness.errors[0] as Error).message, 'socket gone');
  assert.equal(harness.scheduler.pendingFrames, 0);
  harness.scheduler.enqueue(1, frame(1, 2), 'bulk'); // ignored after the failure
  await tick();
  assert.equal(harness.sent.length, 1);
});

test('stop drops queued frames and ignores later ones; a synchronous send throw is handled like a rejection', async () => {
  const harness = createHarness();
  harness.scheduler.enqueue(1, frame(1, 0), 'bulk');
  harness.scheduler.enqueue(1, frame(1, 1), 'bulk');
  harness.scheduler.stop();
  assert.equal(harness.scheduler.pendingFrames, 0);
  harness.scheduler.enqueue(1, frame(1, 2), 'bulk');
  await harness.releaseAll();
  assert.equal(harness.sent.length, 1);
  harness.scheduler.stop(); // idempotent

  const errors: unknown[] = [];
  const throwing = createSendScheduler({
    send: () => {
      throw new Error('sync boom');
    },
    onError: (error) => errors.push(error),
  });
  throwing.enqueue(1, frame(1, 0), 'control');
  await throwing.drain();
  assert.equal(errors.length, 1);
});

test('random queue/purge/send interleavings send every surviving frame once and keep each stream in order', async () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = createSeededRandom(seed);
    const harness = createHarness();
    const nextSeq = new Map<number, number>();
    let queued = 0;
    for (let step = 0; step < 150; step += 1) {
      const action = random.int(0, 9);
      const streamId = random.int(1, 5);
      if (action < 7) {
        const seq = nextSeq.get(streamId) ?? 0;
        nextSeq.set(streamId, seq + 1);
        const priority: SchedulerPriority = random.int(0, 2) === 0 ? 'bulk' : 'control';
        harness.scheduler.enqueue(streamId, frame(streamId, seq), priority);
        queued += 1;
      } else if (action === 7) {
        const before = harness.scheduler.pendingFrames;
        harness.scheduler.purge(streamId);
        queued -= before - harness.scheduler.pendingFrames;
      } else {
        await harness.release();
      }
    }
    await harness.releaseAll();
    assert.equal(harness.sent.length, queued, `seed ${seed}`);
    const lastSeq = new Map<number, number>();
    for (const { streamId, seq } of harness.sent) {
      assert.ok((lastSeq.get(streamId) ?? -1) < seq, `seed ${seed}: stream ${streamId} out of order`);
      lastSeq.set(streamId, seq);
    }
    assert.equal(harness.scheduler.trackedStreams, 0);
  }
});
