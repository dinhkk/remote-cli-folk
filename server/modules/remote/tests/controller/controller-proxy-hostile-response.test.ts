/**
 * The Controller's HTTP proxy against a hostile Host (the paired peer is the untrusted party): a declared
 * `Content-Length` that the body does not match, header values that could end a header line, redirects and
 * 401/403 in a response head, a Host that keeps many streams full for a browser that does not read (the
 * per-pairing and global receive budgets), an expired pairing, and the errors of opening a stream.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import { MuxFrameError } from '../../mux/frames.js';
import type { FakeStream } from '../support/fake-link.js';
import { open, send } from '../support/http-test-client.js';
import { waitUntil, withHarness, type ProxyHarness } from '../support/proxy-harness.js';

type RawResponse = { raw: Buffer; head: string; body: Buffer };

/**
 * One request on a raw socket, keep-alive, read until the SERVER closes the connection. A response the
 * proxy finishes normally leaves the socket open, so this is for cases where the proxy must cut it off.
 */
const rawGet = (port: number, path: string, headers: Record<string, string>): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the connection was not closed by the proxy'));
    }, 5000);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      const end = raw.indexOf('\r\n\r\n');
      resolve({
        raw,
        head: (end < 0 ? raw : raw.subarray(0, end)).toString('latin1'),
        body: end < 0 ? Buffer.alloc(0) : raw.subarray(end + 4),
      });
    });
    const lines = [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), 'Connection: keep-alive', '', ''];
    socket.write(lines.join('\r\n'));
  });

const errorCode = (body: string): string | undefined => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

describe('Controller HTTP proxy: the Host\'s Content-Length is enforced', () => {
  it('cuts the connection when the body is longer than declared, and never writes a byte past the declared length', async () => {
    await withHarness({}, async (h) => {
      const pending = rawGet(h.port, `/r/${h.peerId}/api/projects`, h.auth());
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json', 'content-length': '5' } });
      stream.body('hello');
      stream.body('HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\nevil');
      const response = await pending;
      assert.ok(response.head.startsWith('HTTP/1.1 200'));
      assert.ok('hello'.startsWith(response.body.toString('latin1')), `the body was ${JSON.stringify(response.body.toString('latin1'))}`);
      assert.ok(!response.raw.includes('evil'), 'bytes beyond the declared length reached the wire');
      assert.ok(stream.closed, 'the stream was ended');
      assert.equal(stream.failure?.code, 'REMOTE_PROTOCOL');
    });
  });

  it('cuts the connection when a single chunk crosses the declared length', async () => {
    await withHarness({}, async (h) => {
      const pending = rawGet(h.port, `/r/${h.peerId}/api/projects`, h.auth());
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json', 'content-length': '5' } });
      stream.body('hello world', true);
      const response = await pending;
      assert.ok(response.body.length <= 5);
      assert.equal(stream.failure?.code, 'REMOTE_PROTOCOL');
    });
  });

  it('cuts the connection when the body ends before the declared length, so the answer cannot look complete', async () => {
    await withHarness({}, async (h) => {
      const pending = rawGet(h.port, `/r/${h.peerId}/api/projects`, h.auth());
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json', 'content-length': '10' } });
      stream.body('hello', true);
      const response = await pending; // resolves only because the proxy closed the connection
      assert.ok(response.head.startsWith('HTTP/1.1 200'));
      assert.ok(response.body.length <= 5);
      assert.equal(stream.failure?.code, 'REMOTE_PROTOCOL');
      assert.ok(stream.closed);
    });
  });

  it('lets a body that matches its declared length through, however it is chunked, and keeps the connection', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'text/plain', 'content-length': '11' } });
      stream.body('hello');
      stream.body(' ');
      stream.body('world', true);
      const response = await pending;
      assert.equal(response.status, 200);
      assert.equal(response.text(), 'hello world');
      assert.equal(response.headers['content-length'], '11');
      assert.equal(stream.failure, null);
    });
  });

  it('does not enforce a length for 304 (the Host answered a conditional request with no body)', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: { ...h.auth(), 'if-none-match': '"abc"' } });
      const stream = await h.nextStream();
      stream.respond({ status: 304, headers: { etag: '"abc"', 'content-length': '120' } });
      stream.body('', true);
      const response = await pending;
      assert.equal(response.status, 304);
      assert.equal(stream.failure, null);
    });
  });
});

describe('Controller HTTP proxy: response header values from the Host', () => {
  const hostile: Array<[string, string, string]> = [
    ['CR LF (a second header line)', 'etag', '"a"\r\nSet-Cookie: sid=evil'],
    ['LF only', 'x-request-id', 'a\nb'],
    ['NUL', 'content-disposition', 'attachment; filename="a\u0000b"'],
    ['DEL', 'content-type', 'text/plain\u007f'],
    ['another control character', 'last-modified', 'Mon\u0001, 01 Jan 2024'],
  ];

  for (const [label, name, value] of hostile) {
    it(`a header value with ${label} fails the response with 502 REMOTE_INTERNAL; nothing from it reaches the browser`, async () => {
      await withHarness({}, async (h) => {
        const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
        const stream = await h.nextStream();
        stream.respond({ status: 200, headers: { 'content-type': 'application/json', [name]: value } });
        const response = await pending;
        assert.equal(response.status, 502);
        assert.equal(errorCode(response.text()), 'REMOTE_INTERNAL');
        assert.equal(response.headers['set-cookie'], undefined);
        assert.ok(stream.closed);
        assert.equal(stream.failure?.code, 'REMOTE_INTERNAL');
      });
    });
  }

  it('still carries a legitimate Latin-1 value', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'café-1' } });
      stream.body('{}', true);
      const response = await pending;
      assert.equal(response.status, 200);
    });
  });
});

describe('Controller HTTP proxy: redirects and auth statuses in a response head', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`a ${status} from the Host is a 502 REMOTE_INTERNAL: no redirect, no Location, ever reaches the browser`, async () => {
      await withHarness({}, async (h) => {
        const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
        const stream = await h.nextStream();
        stream.respond({ status, headers: { location: 'https://evil.example/steal', 'content-type': 'text/html' } });
        stream.body('', true);
        const response = await pending;
        assert.equal(response.status, 502);
        assert.equal(response.headers.location, undefined);
        assert.equal(errorCode(response.text()), 'REMOTE_INTERNAL');
        assert.ok(stream.closed);
      });
    });
  }

  it('keeps 204 working and keeps 401/403 as 502 REMOTE_UPSTREAM_AUTH', async () => {
    await withHarness({}, async (h) => {
      const empty = send(h.port, { method: 'DELETE', path: `/r/${h.peerId}/api/projects/x`, headers: { ...h.auth(), 'content-length': '0' } });
      const first = await h.nextStream();
      first.respond({ status: 204, headers: {} });
      first.body('', true);
      assert.equal((await empty).status, 204);

      const denied = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const second = await h.nextStream(1);
      second.respond({ status: 403, headers: {} });
      const response = await denied;
      assert.equal(response.status, 502);
      assert.equal(errorCode(response.text()), 'REMOTE_UPSTREAM_AUTH');
    });
  });
});

describe('Controller HTTP proxy: aggregate receive budget', () => {
  const MIB = 1024 * 1024;

  /** Opens `count` responses on `peerId` whose browsers never read, returning the streams. */
  const openUnreadStreams = async (h: ProxyHarness, peerId: string, token: string, count: number, firstIndex: number) => {
    const opened: Array<{ stream: FakeStream; res: { pause(): void; destroy(): void } }> = [];
    for (let i = 0; i < count; i += 1) {
      const request = open(h.port, { path: `/r/${peerId}/api/assets/files/big`, headers: h.auth(token) });
      const stream = await h.nextStream(firstIndex + i);
      stream.respond({ status: 200, headers: { 'content-type': 'application/octet-stream' } });
      const { res } = await request;
      res.pause();
      opened.push({ stream, res });
    }
    return opened;
  };

  /** Writes 64 KiB chunks round-robin until a stream is cut; returns how many bytes the Host managed to send in all. */
  const flood = async (streams: Array<{ stream: FakeStream }>): Promise<number> => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    let sent = 0;
    for (let round = 0; round < 1500 && !streams.some(({ stream }) => stream.closed); round += 1) {
      for (const { stream } of streams) {
        if (stream.closed) continue;
        stream.body(chunk);
        sent += chunk.length;
      }
      if (round % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return sent;
  };

  // With four streams the old per-stream budget alone (16 MiB each, now 8 MiB) lets 64 (now 32) MiB pile up
  // before anything is cut; the aggregate budgets cut much earlier, which is what these bounds tell apart.
  const SINGLE_STREAM_BUDGETS_WOULD_ALLOW = 28 * MIB;

  it('cuts streams with REMOTE_QUOTA when the unread bytes of one pairing add up over the pairing budget, though no stream is near its own budget', async () => {
    await withHarness({ receiveBudgets: { perStream: 256 * MIB, perPairing: 1 * MIB, global: 512 * MIB } }, async (h) => {
      const streams = await openUnreadStreams(h, h.peerId, h.tabToken, 4, 0);
      const sent = await flood(streams);
      const cut = streams.filter(({ stream }) => stream.closed);
      assert.ok(cut.length >= 1, 'a stream was cut once the pairing total passed its budget');
      assert.ok(sent < SINGLE_STREAM_BUDGETS_WOULD_ALLOW, `${sent} bytes were sent before the first cut: only a per-stream budget acted`);
      for (const { stream } of cut) assert.equal(stream.failure?.code, 'REMOTE_QUOTA');
      for (const { res } of streams) res.destroy();
    });
  });

  it('cuts streams when the unread bytes of several pairings add up over the global budget, though each pairing is within its own', async () => {
    await withHarness({ receiveBudgets: { perStream: 256 * MIB, perPairing: 256 * MIB, global: 1 * MIB } }, async (h) => {
      const a = await openUnreadStreams(h, h.peerId, h.tabToken, 2, 0);
      const b = await openUnreadStreams(h, h.otherPeerId, h.otherPeerToken, 2, 2);
      const sent = await flood([...a, ...b]);
      const cut = [...a, ...b].filter(({ stream }) => stream.closed);
      assert.ok(cut.length >= 1);
      assert.ok(sent < SINGLE_STREAM_BUDGETS_WOULD_ALLOW, `${sent} bytes were sent before the first cut: only a per-stream budget acted`);
      for (const { stream } of cut) assert.equal(stream.failure?.code, 'REMOTE_QUOTA');
      for (const { res } of [...a, ...b]) res.destroy();
    });
  });

  it('leaves streams alone while their browsers keep up', async () => {
    await withHarness({ receiveBudgets: { perStream: 256 * MIB, perPairing: 2 * MIB, global: 4 * MIB } }, async (h) => {
      const request = open(h.port, { path: `/r/${h.peerId}/api/assets/files/big`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/octet-stream' } });
      const { res } = await request;
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      const chunk = Buffer.alloc(64 * 1024, 1);
      for (let i = 0; i < 200; i += 1) {
        stream.body(chunk);
        if (i % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      }
      stream.body('', true);
      await waitUntil(() => res.complete, 'the whole body to arrive');
      assert.equal(received, 200 * chunk.length);
      assert.equal(stream.failure, null);
    });
  });
});

describe('Controller HTTP proxy: pairing expiry and stream-open errors', () => {
  it('refuses /r for an expired pairing with 410 REMOTE_PEER_EXPIRED before opening a stream, even with a token issued earlier', async () => {
    await withHarness({ peerExpiresAt: Date.now() + 60_000 }, async (h) => {
      const early = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json' } });
      stream.body('[]', true);
      assert.equal((await early).status, 200, 'works before the expiry');

      h.clock.advance(61_000);
      const late = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(late.status, 410);
      assert.equal(errorCode(late.text()), 'REMOTE_PEER_EXPIRED');
      assert.equal(late.headers['x-auth-error'], undefined, 'an expired pairing must not look like the end of the Local session');
      assert.equal(h.link.streams.length, 1, 'no stream was opened for the expired pairing');
    });
  });

  it('keeps the other pairings working when one is expired', async () => {
    await withHarness({ peerExpiresAt: Date.now() + 60_000 }, async (h) => {
      h.clock.advance(61_000);
      const pending = send(h.port, { path: `/r/${h.otherPeerId}/api/projects`, headers: h.auth(h.otherPeerToken) });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json' } });
      stream.body('[]', true);
      assert.equal((await pending).status, 200);
    });
  });

  it('answers 503 REMOTE_LINK_DOWN, not 400, when stream ids ran out or the stream table closed under the request', async () => {
    await withHarness({}, async (h) => {
      h.link.onOpen = () => {
        throw new Error('Stream ids are exhausted; the session must be re-established.');
      };
      const response = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(response.status, 503);
      assert.equal(errorCode(response.text()), 'REMOTE_LINK_DOWN');
    });
  });

  it('still answers 400 REMOTE_BAD_REQUEST for a request whose target the mux cannot encode', async () => {
    await withHarness({}, async (h) => {
      h.link.onOpen = () => {
        throw new MuxFrameError('bad-meta');
      };
      const response = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.text()), 'REMOTE_BAD_REQUEST');
    });
  });
});
