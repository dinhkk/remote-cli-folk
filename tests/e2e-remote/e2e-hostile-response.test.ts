// The Host is untrusted on the response side too: a real Controller server in front of a hand-made Host that
// lies about the body length, smuggles header lines, redirects, or never stops sending. The browser (a raw
// socket here, so nothing "fixes" a bad response) must never see a response that is longer or shorter than
// it announced, a smuggled header, or a Host redirect; and the Controller must stay usable afterwards.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { configureRelay } from './support/e2e-world.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';
import { type E2eRelay, startE2eRelay } from './support/e2e-relay.js';
import { waitUntil } from './support/e2e-util.js';

type Raw = { head: string; body: Buffer; ended: boolean };

/** One HTTP/1.1 GET over a plain socket; resolves when the Controller closes the connection (or after `timeoutMs`). */
const rawGet = (port: number, path: string, token: string, timeoutMs = 10_000): Promise<Raw> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1');
    let ended = false;
    const finish = (): void => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf('\r\n\r\n');
      resolve(split < 0 ? { head: all.toString('latin1'), body: Buffer.alloc(0), ended } : { head: all.subarray(0, split).toString('latin1'), body: all.subarray(split + 4), ended });
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, timeoutMs);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      ended = true;
      clearTimeout(timer);
      finish();
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
  });

const statusOf = (raw: Raw): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw.head)?.[1] ?? 0);

describe('a hostile Host answering with a lying or malformed response', () => {
  let relay: E2eRelay;
  let controller: E2eServer;
  let host: HostileHost;
  let token = '';

  const path = (suffix: string): string => `/r/${host.peerId}${suffix}`;

  before(async () => {
    relay = await startE2eRelay();
    controller = await startE2eServer({ name: 'controller' });
    await configureRelay(relay, controller);
    host = await startHostileHost(relay, controller);
    token = (await controller.api(`/api/remote/peers/${host.peerId}/tab-token`, { method: 'POST', body: {} })).json<{ tabToken: string }>().tabToken;
  });
  after(async () => {
    host?.stop();
    await controller?.stop();
    await relay?.stop();
  });

  const answerWith = (headers: Record<string, string>, body: string, status = 200): void =>
    host.respond(({ stream }) => {
      stream.sendResponse({ status, headers });
      stream.writeBody(Buffer.from(body), true);
    });

  const stillServes = async (): Promise<void> => {
    answerWith({ 'content-type': 'application/json' }, '{"fine":true}');
    const response = await controller.api(path('/api/projects'), { token });
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"fine":true}');
  };

  it('a body longer than the announced Content-Length is cut: the browser never receives the extra bytes', async () => {
    answerWith({ 'content-type': 'application/json', 'content-length': '5' }, 'abcde-and-more-than-announced');
    const raw = await rawGet(controller.port, path('/api/projects'), token);
    assert.ok(raw.ended, 'the connection was closed');
    assert.ok(raw.body.length <= 5, `got ${raw.body.length} body bytes`);
    assert.ok(!raw.body.toString().includes('and-more'));
    await stillServes();
  });

  it('a body shorter than the announced Content-Length ends the connection instead of looking complete', async () => {
    answerWith({ 'content-type': 'application/json', 'content-length': '50' }, 'short');
    const raw = await rawGet(controller.port, path('/api/projects'), token);
    assert.ok(raw.ended);
    if (statusOf(raw) === 200) assert.ok(raw.body.length < 50, 'the client can see that the body is incomplete');
    else assert.notEqual(statusOf(raw), 200);
    await stillServes();
  });

  it('an exact Content-Length passes through untouched', async () => {
    answerWith({ 'content-type': 'application/json', 'content-length': '11' }, '{"ok":true}');
    const response = await controller.api(path('/api/projects'), { token });
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"ok":true}');
  });

  for (const [label, value] of [
    ['CRLF smuggling a Set-Cookie line', 'ok\r\nSet-Cookie: session=evil'],
    ['a bare LF', 'ok\nX-Injected: 1'],
    ['a NUL byte', 'ok\u0000evil'],
  ] as const) {
    it(`a header value with ${label} is refused with 502 REMOTE_INTERNAL and nothing of it reaches the browser`, async () => {
      answerWith({ 'content-type': 'application/json', 'x-request-id': value }, '{"ok":true}');
      const raw = await rawGet(controller.port, path('/api/projects'), token);
      assert.equal(statusOf(raw), 502, raw.head);
      assert.ok(!/set-cookie/i.test(raw.head), 'no smuggled header line');
      assert.ok(!/x-injected/i.test(raw.head));
      assert.match(raw.body.toString(), /REMOTE_INTERNAL/);
      await stillServes();
    });
  }

  for (const status of [301, 302, 303, 307, 308]) {
    it(`a Host redirect (${status}) is not forwarded: 502 and no Location`, async () => {
      answerWith({ location: 'https://evil.example/steal', 'content-type': 'text/html' }, '', status);
      const raw = await rawGet(controller.port, path('/api/projects'), token);
      assert.equal(statusOf(raw), 502, raw.head);
      assert.ok(!/location:/i.test(raw.head));
    });
  }

  it('a Host that keeps sending to a browser that does not read is stopped well before it can fill the Controller memory, and the Controller stays up', async () => {
    let sent = 0;
    let stopped = false;
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    host.respond(({ stream }) => {
      stream.sendResponse({ status: 200, headers: { 'content-type': 'application/octet-stream' } });
      stream.setHandlers({ onClosed: () => (stopped = true) });
      const pump = (): void => {
        while (!stopped && !stream.closed && sent < 200 * 1024 * 1024) {
          const accepted = stream.writeBody(chunk, false);
          sent += chunk.length;
          if (!accepted) {
            setTimeout(pump, 5);
            return;
          }
        }
        stopped = true;
      };
      pump();
    });
    // A client that reads nothing: the socket is paused, so the Controller's own send buffer fills up.
    const socket = net.connect(controller.port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.pause();
    socket.write(`GET ${path('/api/projects')} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
    await waitUntil(() => stopped, 'the flooding stream to be cut', 40_000);
    socket.destroy();
    assert.ok(sent < 120 * 1024 * 1024, `the Host got to send ${sent} bytes`);
    assert.equal((await fetch(`${controller.baseUrl}/health`)).status, 200);
    await stillServes();
  });
});
