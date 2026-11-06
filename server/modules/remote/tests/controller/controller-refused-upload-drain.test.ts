/**
 * The refusal of an oversized upload on the Controller proxy: the body is read and dropped so the 413 reaches a
 * browser that is still sending, but every budget is a hard stop (time, bytes, chunked bodies, concurrency),
 * the connection is closed after the answer, and a running drain is cut by revoke/unpair like any other
 * browser connection.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it } from 'node:test';

import { DEFAULT_REFUSED_UPLOAD_BUDGETS, createRefusedUploadDrain, resolveRefusedUploadBudgets } from '../../controller/refused-upload-drain.js';
import { send } from '../support/http-test-client.js';
import { waitUntil, withHarness, type ProxyHarness } from '../support/proxy-harness.js';

const MIB = 1024 * 1024;
/** The proxy refuses any body over this; the synthetic route is allowed by the test policy. */
const LIMIT = 1000;

type Answer = { status: number; connection: string | undefined; code: string | undefined };
type Upload = {
  req: http.ClientRequest;
  /** The answer, or null when the connection ended without one. */
  answer: Promise<Answer | null>;
  /** Resolves when the connection is gone. */
  closed: Promise<void>;
  isClosed(): boolean;
  write(chunk: Buffer): boolean;
  sent(): number;
};

/** Starts a POST to the proxy and keeps it open: the caller decides what to send and when (a browser mid-upload). */
const startUpload = (h: ProxyHarness, headers: Record<string, string>, peer: { id: string; token: string } = { id: h.peerId, token: h.tabToken }): Upload => {
  let sent = 0;
  let closed = false;
  const req = http.request({
    host: '127.0.0.1',
    port: h.port,
    method: 'POST',
    path: `/r/${peer.id}/api/projects/create-project`,
    // A browser keeps connections alive: only an explicit `Connection: close` from the proxy ends this one.
    headers: { ...h.auth(peer.token), 'content-type': 'application/octet-stream', connection: 'keep-alive', ...headers },
    agent: false,
  });
  const answer = new Promise<Answer | null>((resolve) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', () => undefined);
      res.on('end', () => {
        let code: string | undefined;
        try {
          code = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: string } }).error?.code;
        } catch {
          code = undefined;
        }
        resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, code });
      });
    });
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));
  });
  const done = new Promise<void>((resolve) =>
    req.on('close', () => {
      closed = true;
      resolve();
    }),
  );
  return {
    req,
    answer,
    closed: done,
    isClosed: () => closed,
    write(chunk) {
      sent += chunk.length;
      return req.write(chunk);
    },
    sent: () => sent,
  };
};

/** Fails the test instead of hanging when `promise` does not settle in time. */
const within = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
};

/** Writes `limit` bytes in 256 KiB pieces, stopping as soon as the connection is gone. */
const flood = async (upload: Upload, limit: number): Promise<void> => {
  const chunk = Buffer.alloc(256 * 1024, 1);
  while (!upload.isClosed() && upload.sent() < limit) {
    if (upload.write(chunk)) continue;
    await new Promise<void>((resolve) => {
      upload.req.once('drain', resolve);
      void upload.closed.then(resolve);
    });
  }
};

describe('refused upload drain: hard stops', () => {
  it('a Content-Length that lies (declares 30 MB, sends 1 byte, holds the socket) is answered when the time budget runs out, and the connection is closed', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { graceMs: 300 } }, async (h) => {
      const started = Date.now();
      const upload = startUpload(h, { 'content-length': '30000000' });
      upload.write(Buffer.from('x'));
      const answer = await within(upload.answer, 5000, 'the 413 after the time budget');
      assert.equal(answer?.status, 413);
      assert.equal(answer?.code, 'REMOTE_TOO_LARGE');
      assert.equal(answer?.connection, 'close');
      assert.ok(Date.now() - started >= 250, 'the budget, not an early answer');
      await within(upload.closed, 2000, 'the connection to be closed after the answer');
      await waitUntil(() => h.liveConnections() === 0, 'the drain to be unregistered');
      assert.equal(h.link.streams.length, 0, 'nothing was forwarded');
    });
  });

  it('a body that keeps coming past the byte budget is answered and the connection cut: the server stops reading', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { maxBytes: 64 * 1024, graceMs: 20_000 } }, async (h) => {
      const total = 200 * MIB;
      const upload = startUpload(h, { 'content-length': String(total) });
      await within(flood(upload, total), 15_000, 'the server to cut the connection');
      await within(upload.closed, 5000, 'the connection to close');
      assert.ok(upload.sent() < total / 2, `the browser was cut off long before the end (sent ${upload.sent()} of ${total})`);
      const answer = await upload.answer;
      assert.ok(answer === null || answer.status === 413, 'a 413 or a reset (the server is cutting a sender that has not stopped)');
      await waitUntil(() => h.liveConnections() === 0, 'the drain to be unregistered');
      assert.equal(h.link.streams.length, 0, 'nothing was forwarded');
    });
  });

  it('a chunked body (no declared length) that grows past the limit and keeps going is cut at its own byte budget', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { maxBytes: 64 * 1024, graceMs: 20_000 } }, async (h) => {
      const total = 200 * MIB;
      const upload = startUpload(h, { 'transfer-encoding': 'chunked' });
      await within(flood(upload, total), 15_000, 'the server to cut the connection');
      await within(upload.closed, 5000, 'the connection to close');
      assert.ok(upload.sent() < total / 2, `the browser was cut off long before the end (sent ${upload.sent()} of ${total})`);
      const answer = await upload.answer;
      assert.ok(answer === null || answer.status === 413);
      const stream = h.link.streams[0];
      assert.equal(stream.failure?.code, 'REMOTE_TOO_LARGE', 'the stream the proxy had opened was ended');
      await waitUntil(() => h.liveConnections() === 0, 'the drain to be unregistered');
    });
  });

  it('a browser that goes away mid-drain frees the drain slot and gets no answer', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { graceMs: 20_000, perPairing: 1 } }, async (h) => {
      const first = startUpload(h, { 'content-length': '30000000' });
      first.write(Buffer.from('x'));
      await waitUntil(() => h.liveConnections() === 1, 'the drain to start');
      first.req.destroy();
      await waitUntil(() => h.liveConnections() === 0, 'the drain to end after the browser left');
      assert.equal(await first.answer, null);

      // The slot is free again: the next refused upload is drained (and answered once its budget ends), not refused at once.
      const second = startUpload(h, { 'content-length': '30000000' });
      second.write(Buffer.from('x'));
      await waitUntil(() => h.liveConnections() === 1, 'the next drain to start');
      second.req.destroy();
      await waitUntil(() => h.liveConnections() === 0, 'the next drain to end');
    });
  });

  it('refuses at once, and closes, a refused upload beyond the per-pairing cap; other pairings and freed slots are not affected', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { graceMs: 20_000, perPairing: 2, global: 16 } }, async (h) => {
      const held = [startUpload(h, { 'content-length': '30000000' }), startUpload(h, { 'content-length': '30000000' })];
      for (const upload of held) upload.write(Buffer.from('x'));
      await waitUntil(() => h.liveConnections() === 2, 'two drains to run');

      const started = Date.now();
      const excess = startUpload(h, { 'content-length': '30000000' });
      excess.write(Buffer.from('x'));
      const answer = await within(excess.answer, 3000, 'the immediate 413');
      assert.equal(answer?.status, 413);
      assert.equal(answer?.connection, 'close');
      assert.ok(Date.now() - started < 2500, 'answered without waiting for any budget');
      await within(excess.closed, 2000, 'the excess connection to close');
      assert.equal(h.liveConnections(), 2, 'the excess request took no slot');

      // Another pairing has its own slots.
      const otherPairing = startUpload(h, { 'content-length': '30000000' }, { id: h.otherPeerId, token: h.otherPeerToken });
      otherPairing.write(Buffer.from('x'));
      await waitUntil(() => h.liveConnections() === 3, 'a drain of the other pairing to run');

      for (const upload of [...held, otherPairing]) upload.req.destroy();
      await waitUntil(() => h.liveConnections() === 0, 'all drains to end');
    });
  });

  it('refuses at once beyond the global cap even for a pairing that has no drain running', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { graceMs: 20_000, perPairing: 4, global: 2 } }, async (h) => {
      const held = [startUpload(h, { 'content-length': '30000000' }), startUpload(h, { 'content-length': '30000000' })];
      for (const upload of held) upload.write(Buffer.from('x'));
      await waitUntil(() => h.liveConnections() === 2, 'two drains to run');

      const other = startUpload(h, { 'content-length': '30000000' }, { id: h.otherPeerId, token: h.otherPeerToken });
      other.write(Buffer.from('x'));
      const answer = await within(other.answer, 3000, 'the immediate 413');
      assert.equal(answer?.status, 413);
      assert.equal(h.liveConnections(), 2);
      for (const upload of held) upload.req.destroy();
      await waitUntil(() => h.liveConnections() === 0, 'all drains to end');
    });
  });

  it('a running drain is cut when the registry closes the pairing connections (revoke, unpair, link down): no answer, connection gone', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT, refusedUpload: { graceMs: 20_000 } }, async (h) => {
      const upload = startUpload(h, { 'content-length': '30000000' });
      upload.write(Buffer.from('x'));
      await waitUntil(() => h.liveConnections() === 1, 'the drain to start');
      assert.equal(h.registry.closeConnections(), 1, 'the drain is one of the pairing connections');
      await within(upload.closed, 3000, 'the drain connection to be cut');
      assert.equal(await upload.answer, null);
      assert.equal(h.liveConnections(), 0);
    });
  });

  it('a complete body is answered with 413 and Connection: close once the browser finished (the answer is not lost to a reset)', async () => {
    await withHarness({ maxRequestBodyBytes: LIMIT }, async (h) => {
      const res = await send(h.port, {
        method: 'POST',
        path: `/r/${h.peerId}/api/projects/create-project`,
        headers: { ...h.auth(), 'content-type': 'application/octet-stream', connection: 'keep-alive' },
        body: Buffer.alloc(5 * MIB, 1),
      });
      assert.equal(res.status, 413);
      assert.equal(res.headers.connection, 'close');
      await waitUntil(() => h.liveConnections() === 0, 'the drain to be unregistered');
    });
  });
});

describe('refused upload drain: refusal path hygiene', () => {
  const fakes = () => {
    const req = Object.assign(new EventEmitter(), { pause: () => undefined, resume: () => undefined, socket: { destroy: () => undefined } });
    const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader: () => undefined, destroy: () => undefined });
    return { req, res };
  };

  it('the response and the request have an error listener before anything is written, so a dying socket cannot crash the process', () => {
    const drain = createRefusedUploadDrain({ budgets: resolveRefusedUploadBudgets({}, { perPairing: 1 }), registry: { trackConnection: () => () => undefined } });
    for (const label of ['drained', 'refused at once (over the cap)']) {
      const { req, res } = fakes();
      drain.refuse(req as never, res as never, 'p1', () => undefined);
      assert.ok(res.listenerCount('error') > 0, `${label}: response`);
      assert.ok(req.listenerCount('error') > 0, `${label}: request`);
      assert.doesNotThrow(() => res.emit('error', new Error('EPIPE')), label);
      assert.doesNotThrow(() => req.emit('error', new Error('ECONNRESET')), label);
    }
  });

  it('a drain that ends because the response closed frees its slot exactly once', () => {
    const drain = createRefusedUploadDrain({ budgets: resolveRefusedUploadBudgets(), registry: { trackConnection: () => () => undefined } });
    const { req, res } = fakes();
    drain.refuse(req as never, res as never, 'p1', () => undefined);
    assert.equal(drain.active, 1);
    res.emit('close');
    res.emit('close');
    req.emit('end');
    assert.equal(drain.active, 0);
  });
});

describe('refused upload drain: budgets', () => {
  it('defaults are 15 s, 128 MiB, 4 per pairing, 16 in total', () => {
    assert.deepEqual(resolveRefusedUploadBudgets(), DEFAULT_REFUSED_UPLOAD_BUDGETS);
    assert.deepEqual(DEFAULT_REFUSED_UPLOAD_BUDGETS, { graceMs: 15_000, maxBytes: 128 * MIB, perPairing: 4, global: 16 });
  });

  it('are overridden by the environment (ms, MiB, counts) and then by explicit values; junk is ignored', () => {
    const env = {
      CLOUDCLI_REMOTE_REFUSED_UPLOAD_GRACE_MS: '2000',
      CLOUDCLI_REMOTE_REFUSED_UPLOAD_MAX_MIB: '8',
      CLOUDCLI_REMOTE_REFUSED_UPLOAD_PER_PAIRING: '2',
      CLOUDCLI_REMOTE_REFUSED_UPLOAD_GLOBAL: 'lots',
    };
    assert.deepEqual(resolveRefusedUploadBudgets(env), { graceMs: 2000, maxBytes: 8 * MIB, perPairing: 2, global: 16 });
    assert.deepEqual(resolveRefusedUploadBudgets(env, { graceMs: 200, maxBytes: 65_536, global: -1 }), { graceMs: 200, maxBytes: 65_536, perPairing: 2, global: 16 });
    assert.deepEqual(resolveRefusedUploadBudgets({ CLOUDCLI_REMOTE_REFUSED_UPLOAD_GRACE_MS: '' }), DEFAULT_REFUSED_UPLOAD_BUDGETS);
  });
});
