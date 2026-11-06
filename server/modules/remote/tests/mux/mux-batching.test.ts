import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteMuxMeta } from '@/shared/types.js';

import { MAX_BATCH_MESSAGES, MAX_BODY_CHUNK_BYTES, SMALL_MESSAGE_BYTES, encodeFrame, splitBatchBody } from '../../mux/frames.js';
import { createMessageBatcher } from '../../mux/message-batcher.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMuxLoopback, tick } from '../support/mux-loopback.js';
import { framesOfType } from '../support/mux-test-helpers.js';
import { createSeededRandom } from '../support/seeded-random.js';

type Emitted = { meta: RemoteMuxMeta['WS_MSG']; body: Buffer };
type Message = { payload: string; binary: boolean };

const setup = (windowMs = 50) => {
  const clock = createManualClock(1_000_000);
  const emitted: Emitted[] = [];
  const batcher = createMessageBatcher({ clock, windowMs, emit: (meta, body) => emitted.push({ meta, body }) });
  return { clock, emitted, batcher };
};

/** Expands emitted frames back into the individual messages, the way the receiving stream does. */
const messagesOf = (emitted: Emitted[]): Message[] =>
  emitted.flatMap(({ meta, body }) =>
    meta.batch === undefined
      ? [{ payload: body.toString('latin1'), binary: meta.binary }]
      : splitBatchBody(body, meta.batch).map((item) => ({ payload: item.toString('latin1'), binary: meta.binary })),
  );

test('200 small messages within one second leave in at most 20 batches, in order, boundaries intact', () => {
  const { clock, emitted, batcher } = setup();
  const sent: Message[] = [];
  for (let i = 0; i < 200; i += 1) {
    const payload = JSON.stringify({ type: 'chunk', n: i });
    sent.push({ payload, binary: false });
    batcher.push(Buffer.from(payload), false);
    clock.advance(5);
  }
  clock.advance(100); // let the last window close
  assert.ok(emitted.length <= 20, `expected <= 20 frames, got ${emitted.length}`);
  assert.ok(emitted.length >= 10, 'messages should actually be grouped, not sent one by one');
  assert.deepEqual(messagesOf(emitted), sent);
  assert.equal(batcher.pendingBytes, 0);
});

test('thousands of empty messages inside one window never build a batch the codec would refuse', () => {
  const { clock, emitted, batcher } = setup();
  const count = MAX_BATCH_MESSAGES * 2 + 100;
  for (let i = 0; i < count; i += 1) batcher.push(Buffer.alloc(0), false);
  clock.advance(50);
  assert.equal(emitted.reduce((total, entry) => total + (entry.meta.batch ?? 1), 0), count, 'no message was lost');
  for (const entry of emitted) {
    assert.ok((entry.meta.batch ?? 1) <= MAX_BATCH_MESSAGES, `batch of ${entry.meta.batch}`);
    assert.doesNotThrow(() => encodeFrame({ type: 'WS_MSG', streamId: 2, meta: entry.meta, body: entry.body }));
  }
});

test('a lone message leaves as a plain WS_MSG after the window; several leave as a batch', () => {
  const { clock, emitted, batcher } = setup();
  batcher.push(Buffer.from('solo'), false);
  assert.equal(emitted.length, 0, 'nothing is sent before the window ends');
  clock.advance(49);
  assert.equal(emitted.length, 0);
  clock.advance(1);
  assert.deepEqual(emitted.map((entry) => entry.meta), [{ binary: false }]);
  assert.equal(emitted[0].body.toString(), 'solo');

  batcher.push(Buffer.from('a'), false);
  batcher.push(Buffer.from('b'), false);
  clock.advance(50);
  assert.deepEqual(emitted[1].meta, { binary: false, batch: 2 });
  assert.deepEqual(messagesOf(emitted.slice(1)).map((m) => m.payload), ['a', 'b']);
});

test('a large message (> 16 KiB) flushes the pending batch first and then goes out alone', () => {
  const { clock, emitted, batcher } = setup();
  batcher.push(Buffer.from('before-1'), false);
  batcher.push(Buffer.from('before-2'), false);
  const large = Buffer.alloc(SMALL_MESSAGE_BYTES + 1, 0x61);
  batcher.push(large, false);
  batcher.push(Buffer.from('after'), false);
  clock.advance(50);
  assert.deepEqual(emitted.map((entry) => entry.meta), [{ binary: false, batch: 2 }, { binary: false }, { binary: false }]);
  assert.deepEqual(messagesOf(emitted).map((m) => m.payload.length), [8, 8, SMALL_MESSAGE_BYTES + 1, 5]);
  assert.equal(messagesOf(emitted)[3].payload, 'after');
});

test('a message of exactly 16 KiB is still small and may be batched', () => {
  const { clock, emitted, batcher } = setup();
  batcher.push(Buffer.alloc(SMALL_MESSAGE_BYTES, 1), false);
  batcher.push(Buffer.from('x'), false);
  clock.advance(50);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].meta.batch, 2);
});

test('switching between text and binary flushes the pending batch before the new kind starts', () => {
  const { clock, emitted, batcher } = setup();
  batcher.push(Buffer.from('t1'), false);
  batcher.push(Buffer.from('t2'), false);
  batcher.push(Buffer.from([1, 2]), true);
  batcher.push(Buffer.from([3]), true);
  batcher.push(Buffer.from('t3'), false);
  clock.advance(50);
  assert.deepEqual(
    emitted.map((entry) => entry.meta),
    [{ binary: false, batch: 2 }, { binary: true, batch: 2 }, { binary: false }],
  );
  assert.deepEqual(messagesOf(emitted).map((m) => [m.binary, m.payload.length]), [[false, 2], [false, 2], [true, 2], [true, 1], [false, 2]]);
});

test('flush sends the pending batch immediately and stops the window timer', () => {
  const { clock, emitted, batcher } = setup();
  batcher.flush(); // nothing pending: no frame
  assert.equal(emitted.length, 0);
  batcher.push(Buffer.from('a'), false);
  batcher.push(Buffer.from('b'), false);
  assert.equal(clock.pendingTimers(), 1);
  batcher.flush();
  assert.equal(emitted.length, 1);
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(500);
  assert.equal(emitted.length, 1, 'the cancelled window must not fire again');
});

test('discard drops pending messages and the timer', () => {
  const { clock, emitted, batcher } = setup();
  batcher.push(Buffer.from('gone'), false);
  assert.equal(batcher.pendingBytes, 4 + 4);
  batcher.discard();
  assert.equal(batcher.pendingBytes, 0);
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(500);
  assert.equal(emitted.length, 0);
});

test('a batch never grows past one body chunk: reaching the cap flushes early', () => {
  const { clock, emitted, batcher } = setup();
  const message = Buffer.alloc(8 * 1024, 0x62);
  for (let i = 0; i < 20; i += 1) batcher.push(message, false);
  clock.advance(50);
  assert.ok(emitted.length >= 3);
  for (const { body } of emitted) assert.ok(body.length <= MAX_BODY_CHUNK_BYTES, `batch body ${body.length}`);
  assert.equal(messagesOf(emitted).length, 20);
});

test('the pushed payload is copied: later changes by the caller do not alter a pending message', () => {
  const { clock, emitted, batcher } = setup();
  const reused = Buffer.from('aaaa');
  batcher.push(reused, false);
  reused.fill(0x7a);
  batcher.push(Buffer.from('bbbb'), false);
  clock.advance(50);
  assert.deepEqual(messagesOf(emitted).map((m) => m.payload), ['aaaa', 'bbbb']);
});

test('each window starts with the first message after the previous flush', () => {
  const { clock, emitted, batcher } = setup();
  batcher.push(Buffer.from('1'), false);
  clock.advance(50);
  clock.advance(500); // quiet: no timer runs
  assert.equal(clock.pendingTimers(), 0);
  batcher.push(Buffer.from('2'), false);
  assert.equal(clock.pendingTimers(), 1);
  clock.advance(50);
  assert.equal(emitted.length, 2);
});

// ---------------------------------------------------------------------------
// Stream level: batching applies to Host -> Controller only and never reorders
// ---------------------------------------------------------------------------

/** A Controller WS stream whose Host counterpart is returned; messages arriving at the Controller are recorded. */
const openTerminal = async () => {
  const loop = createMuxLoopback();
  const received: Message[] = [];
  let closed: { code: number; reason: string } | undefined;
  loop.controller.table.openStream(
    { kind: 'ws', meta: { path: '/shell' } },
    {
      onMessage: (payload, binary) => received.push({ payload: payload.toString('latin1'), binary }),
      onClosed: (end) => {
        if (end.cause === 'peer-ws-close') closed = { code: end.code, reason: end.reason };
      },
    },
  );
  await tick();
  return { loop, received, closed: () => closed, host: loop.host.incoming[0].stream };
};

test('stream level: 200 small Host messages in a second become at most 20 frames and all arrive in order', async () => {
  const { loop, received, host } = await openTerminal();
  const sent: Message[] = [];
  for (let i = 0; i < 200; i += 1) {
    const payload = `line ${i}\r\n`;
    sent.push({ payload, binary: false });
    host.sendMessage(Buffer.from(payload), false);
    loop.clock.advance(5);
  }
  loop.clock.advance(100);
  await tick();
  const frames = framesOfType(loop.host.transmitted, 'WS_MSG');
  assert.ok(frames.length <= 20, `${frames.length} WS_MSG frames`);
  assert.deepEqual(received, sent);
});

test('stream level: a large message, a binary switch and WS_CLOSE flush what is pending first', async () => {
  const { loop, received, closed, host } = await openTerminal();
  const expected: Message[] = [];
  const send = (payload: Buffer, binary: boolean) => {
    expected.push({ payload: payload.toString('latin1'), binary });
    host.sendMessage(payload, binary);
  };
  send(Buffer.from('s1'), false);
  send(Buffer.from('s2'), false);
  send(Buffer.alloc(20_000, 0x6c), false); // large: pending batch goes out before it
  send(Buffer.from('s3'), false);
  send(Buffer.from([7, 8]), true); // binary switch: 's3' goes out before it
  send(Buffer.from('s4'), false);
  host.closeWebSocket(1001, 'going away'); // 's4' goes out before the close
  await tick();
  assert.deepEqual(received, expected, 'everything arrived in order without waiting for the window');
  assert.deepEqual(closed(), { code: 1001, reason: 'going away' });
  const types = loop.host.transmitted.map((frame) => frame.type);
  assert.equal(types.at(-1), 'WS_CLOSE');
  assert.equal(loop.clock.pendingTimers(), 0);
});

test('stream level: Controller -> Host messages are never batched or delayed', async () => {
  const loop = createMuxLoopback();
  const received: string[] = [];
  loop.host.handleIncoming = (stream) => stream.setHandlers({ onMessage: (payload) => received.push(payload.toString()) });
  const stream = loop.controller.table.openStream({ kind: 'ws', meta: { path: '/shell' } }, {});
  for (let i = 0; i < 10; i += 1) stream.sendMessage(Buffer.from(`key ${i}`), false);
  await tick(); // no clock movement at all
  assert.deepEqual(received, Array.from({ length: 10 }, (_, i) => `key ${i}`));
  const frames = framesOfType(loop.controller.transmitted, 'WS_MSG');
  assert.equal(frames.length, 10);
  assert.ok(frames.every((frame) => frame.meta.batch === undefined));
});

test('stream level: cancelling drops the pending batch and its timer', async () => {
  const { loop, received, host } = await openTerminal();
  host.sendMessage(Buffer.from('never sent 1'), false);
  host.sendMessage(Buffer.from('never sent 2'), false);
  host.cancel();
  loop.clock.advance(500);
  await tick();
  assert.deepEqual(received, []);
  assert.equal(framesOfType(loop.host.transmitted, 'WS_MSG').length, 0);
  assert.equal(loop.clock.pendingTimers(), 0);
});

test('property: any mix of small, large, text, binary messages and clock movement arrives in the order sent', async () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    const random = createSeededRandom(seed);
    const { loop, received, closed, host } = await openTerminal();
    const expected: Message[] = [];
    const steps = random.int(1, 60);
    for (let step = 0; step < steps; step += 1) {
      const roll = random.int(0, 9);
      const length = roll === 0 ? random.pick([SMALL_MESSAGE_BYTES, SMALL_MESSAGE_BYTES + 1, 30_000]) : random.int(0, 300);
      const payload = random.bytes(length);
      const binary = random.int(0, 3) === 0;
      expected.push({ payload: payload.toString('latin1'), binary });
      host.sendMessage(payload, binary);
      const move = random.pick([0, 0, 7, 49, 50, 120]);
      if (move > 0) loop.clock.advance(move);
    }
    const closing = random.int(0, 1) === 1;
    if (closing) host.closeWebSocket(1000, 'done');
    else loop.clock.advance(100);
    await tick();
    assert.deepEqual(received, expected, `seed ${seed}`);
    if (closing) assert.deepEqual(closed(), { code: 1000, reason: 'done' }, `seed ${seed}`);
    assert.equal(loop.clock.pendingTimers(), 0, `seed ${seed}`);
  }
});
