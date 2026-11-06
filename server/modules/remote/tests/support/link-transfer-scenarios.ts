/**
 * Transfer scenarios run over a connected Host/Controller link pair, whatever the transport below
 * (in-process fake relay or real WebSockets): a 25 MiB upload with an echo of the size, a
 * Host -> Controller download, and an ordered WebSocket echo.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import type { RemoteMuxStream, RemoteRelayLink, RemoteStreamEnd } from '@/shared/types.js';

import { createFlowControl } from './mux-test-helpers.js';
import { waitFor } from './relay-link-rig.js';

const MIB = 1024 * 1024;

/** Controller uploads `size` bytes in 1 MiB writes honoring backpressure; the Host hashes them and answers with the byte count. */
export const runUploadScenario = async (host: RemoteRelayLink, controller: RemoteRelayLink, size = 25 * MIB): Promise<void> => {
  const data = crypto.randomBytes(size);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let largestChunk = 0;
  host.onStream((stream) => {
    stream.setHandlers({
      onBody: (chunk, fin) => {
        hash.update(chunk);
        received += chunk.length;
        largestChunk = Math.max(largestChunk, chunk.length);
        if (!fin) return;
        stream.sendResponse({ status: 200, headers: { 'content-type': 'application/json' } });
        stream.writeBody(Buffer.from(JSON.stringify({ received, sha256: hash.digest('hex') })), true);
      },
    });
  });

  const flow = createFlowControl();
  let stream: RemoteMuxStream | undefined;
  const answer: Buffer[] = [];
  let end: RemoteStreamEnd | undefined;
  stream = controller.openStream(
    { kind: 'http', meta: { method: 'PUT', path: '/api/upload', headers: {} } },
    { ...flow.handlers(() => stream), onBody: (chunk) => answer.push(chunk), onClosed: (e) => (end = e) },
  );
  for (let offset = 0; offset < size; offset += MIB) {
    stream.writeBody(data.subarray(offset, offset + MIB), offset + MIB >= size);
    await flow.untilWritable(stream);
  }
  await waitFor(() => end !== undefined, 'the upload to complete');

  assert.deepEqual(end, { cause: 'completed' });
  const reply = JSON.parse(Buffer.concat(answer).toString()) as { received: number; sha256: string };
  assert.equal(reply.received, size);
  assert.equal(reply.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(largestChunk <= 64 * 1024, `largest body chunk ${largestChunk}`);
  assert.ok(flow.counters.maxQueued <= 8 * MIB);
};

/** Host streams `size` bytes back to the Controller (a download) honoring backpressure. */
export const runDownloadScenario = async (host: RemoteRelayLink, controller: RemoteRelayLink, size = 12 * MIB): Promise<void> => {
  const data = crypto.randomBytes(size);
  host.onStream((stream) => {
    const flow = createFlowControl();
    stream.setHandlers(flow.handlers(() => stream));
    void (async () => {
      stream.sendResponse({ status: 200, headers: { 'content-type': 'application/octet-stream' } });
      for (let offset = 0; offset < size; offset += MIB) {
        stream.writeBody(data.subarray(offset, offset + MIB), offset + MIB >= size);
        await flow.untilWritable(stream);
      }
    })();
  });
  const hash = crypto.createHash('sha256');
  let total = 0;
  let status = 0;
  let end: RemoteStreamEnd | undefined;
  const stream = controller.openStream(
    { kind: 'http', meta: { method: 'GET', path: '/api/download', headers: {} } },
    {
      onResponse: (meta) => (status = meta.status),
      onBody: (chunk) => {
        hash.update(chunk);
        total += chunk.length;
      },
      onClosed: (e) => (end = e),
    },
  );
  stream.writeBody(Buffer.alloc(0), true);
  await waitFor(() => end !== undefined, 'the download to complete');
  assert.equal(status, 200);
  assert.equal(total, size);
  assert.equal(hash.digest('hex'), crypto.createHash('sha256').update(data).digest('hex'));
};

/** Controller sends numbered messages; the Host echoes each one (batched on the way back); order must hold. */
export const runEchoScenario = async (host: RemoteRelayLink, controller: RemoteRelayLink, count = 300): Promise<void> => {
  host.onStream((stream) => {
    stream.setHandlers({ onMessage: (payload, binary) => stream.sendMessage(Buffer.concat([Buffer.from('echo:'), payload]), binary) });
  });
  const received: string[] = [];
  const stream = controller.openStream({ kind: 'ws', meta: { path: '/shell' } }, { onMessage: (payload) => received.push(payload.toString()) });
  for (let i = 0; i < count; i += 1) stream.sendMessage(Buffer.from(`key ${i}`), false);
  await waitFor(() => received.length >= count, 'all echoes');
  assert.deepEqual(received, Array.from({ length: count }, (_, i) => `echo:key ${i}`));
  stream.closeWebSocket(1000, 'done');
};
