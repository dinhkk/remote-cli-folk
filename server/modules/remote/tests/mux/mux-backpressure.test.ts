import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import type { RemoteMuxStream } from '@/shared/types.js';

import { createMuxLoopback, tick } from '../support/mux-loopback.js';
import { createFlowControl } from '../support/mux-test-helpers.js';

const MIB = 1024 * 1024;

/**
 * A PTY replay: 5000 chunks of 4 KiB (20 MB) pushed by a source that is much faster than the link.
 * The Host stream pauses the source at 4 MiB and resumes it at 1 MiB, so the 8 MiB limit is never
 * reached and nothing is lost or reordered.
 */
test('5000 x 4 KiB replay into a slow link: pause at 4 MiB, resume at 1 MiB, never above 8 MiB, no close', async () => {
  const loop = createMuxLoopback({ gated: true });
  const received: number[] = [];
  // The Controller opened the terminal WebSocket; the Host replays into it.
  const controllerStream = loop.controller.table.openStream(
    { kind: 'ws', meta: { path: '/shell' } },
    {
      onMessage: (payload) => {
        assert.equal(payload.length, 4096);
        received.push(payload.readUInt32BE(0));
      },
    },
  );
  await loop.open('toHost'); // WS_OPEN reaches the Host; only Host -> Controller stays slow
  const hostStream = loop.host.incoming[0].stream;
  const flow = createFlowControl();
  hostStream.setHandlers(flow.handlers(() => hostStream));

  let sent = 0;
  const source = (async () => {
    const chunk = Buffer.alloc(4096, 0x42);
    while (sent < 5000) {
      chunk.writeUInt32BE(sent, 0);
      hostStream.sendMessage(chunk, true);
      sent += 1;
      await flow.untilWritable(hostStream);
    }
  })();

  // The receiver is slow: one frame per step, with the clock moving so batch windows close.
  let guard = 0;
  while (received.length < 5000 && guard < 20_000) {
    loop.clock.advance(50);
    await loop.step('toController', 1);
    guard += 1;
  }
  await source;

  assert.equal(received.length, 5000);
  assert.deepEqual(received, Array.from({ length: 5000 }, (_, i) => i), 'order preserved');
  assert.equal(hostStream.closed, false, 'the stream was never closed');
  assert.equal(controllerStream.closed, false);
  assert.ok(flow.counters.pauses >= 2, `expected repeated pauses, got ${flow.counters.pauses}`);
  assert.equal(flow.counters.resumes, flow.counters.pauses, 'every pause was followed by a resume');
  for (const queued of flow.counters.queuedAtPause) assert.ok(queued >= 4 * MIB, `paused at ${queued}`);
  for (const queued of flow.counters.queuedAtResume) assert.ok(queued <= 1 * MIB, `resumed at ${queued}`);
  assert.ok(flow.counters.maxQueued <= 8 * MIB, `peak ${flow.counters.maxQueued}`);
  assert.ok(flow.counters.maxQueued < 5 * MIB, 'a source that honors pause stays close to the high-water mark');
});

test('a 25 MiB upload into a slow link pauses and resumes the sender and arrives intact', async () => {
  const loop = createMuxLoopback({ gated: true });
  const size = 25 * MIB;
  const data = crypto.randomBytes(size);
  const hash = crypto.createHash('sha256');
  let received = 0;
  loop.host.handleIncoming = (stream) => {
    stream.setHandlers({
      onBody: (chunk) => {
        hash.update(chunk);
        received += chunk.length;
      },
    });
  };
  const flow = createFlowControl();
  let stream: RemoteMuxStream | undefined;
  stream = loop.controller.table.openStream({ kind: 'http', meta: { method: 'PUT', path: '/api/upload', headers: {} } }, flow.handlers(() => stream));
  const sender = (async () => {
    for (let offset = 0; offset < size; offset += MIB) {
      stream.writeBody(data.subarray(offset, offset + MIB), offset + MIB >= size);
      await flow.untilWritable(stream);
    }
  })();

  let guard = 0;
  while (received < size && guard < 5000) {
    await loop.step('toHost', 1);
    guard += 1;
  }
  await sender;
  await tick();

  assert.equal(received, size);
  assert.equal(hash.digest('hex'), crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(flow.counters.pauses >= 3, `the 25 MiB upload should have been paused repeatedly, got ${flow.counters.pauses}`);
  assert.equal(flow.counters.resumes, flow.counters.pauses);
  assert.ok(flow.counters.maxQueued <= 8 * MIB);
});

test('queued bytes include messages still held back by the Host batching window', async () => {
  const loop = createMuxLoopback();
  loop.controller.table.openStream({ kind: 'ws', meta: { path: '/ws' } }, {});
  await tick();
  const hostStream = loop.host.incoming[0].stream;
  hostStream.sendMessage(Buffer.alloc(1000), false);
  hostStream.sendMessage(Buffer.alloc(1000), false);
  assert.equal(hostStream.queuedBytes, 2 * 1004);
  loop.clock.advance(50);
  await tick();
  assert.equal(hostStream.queuedBytes, 0);
});

test('the pause signal fires once per crossing and resume only after draining below the low mark', async () => {
  const loop = createMuxLoopback({
    gated: true,
    controllerLimits: { maxQueuedBytes: 2000, pauseHighWaterBytes: 400, resumeLowWaterBytes: 100 },
  });
  const events: string[] = [];
  const stream = loop.controller.table.openStream(
    { kind: 'ws', meta: { path: '/ws' } },
    { onPause: () => events.push('pause'), onResume: () => events.push('resume') },
  );
  const messages = (count: number) => {
    for (let i = 0; i < count; i += 1) stream.sendMessage(Buffer.alloc(40), false);
  };
  messages(3); // WS_OPEN is in flight; three queued frames are well below the mark
  assert.deepEqual(events, []);
  assert.equal(stream.paused, false);
  messages(12);
  assert.deepEqual(events, ['pause']);
  assert.equal(stream.paused, true);
  messages(2);
  assert.deepEqual(events, ['pause'], 'no second pause while already paused');

  await loop.step('toHost', 6); // still above the low-water mark
  assert.deepEqual(events, ['pause']);
  await loop.open('toHost');
  assert.deepEqual(events, ['pause', 'resume']);
  assert.equal(stream.paused, false);
});
