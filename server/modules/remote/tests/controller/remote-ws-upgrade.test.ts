/**
 * WebSocket side of the Controller proxy through the REAL websocket gateway (contracts sections 1, 3):
 * the tab token rides in `Sec-WebSocket-Protocol` (never the URL), the gateway echoes the marker and
 * never the token, only a tab token for this peer opens `/r/<peerId>/(ws|shell)`, the regular sockets
 * still take only the main JWT, `/shell` upgrades are spaced out, and messages, closes and back-pressure
 * are bridged to a mux stream.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { createWebSocketServer } from '@/modules/websocket/index.js';

import { createRemoteWebSocketGateway } from '../../controller/controller-ws-proxy.service.js';
import { serve } from '../support/http-test-client.js';
import { closed, waitFor, withGatewayHarness } from '../support/ws-gateway-harness.js';

describe('Remote WebSocket upgrade', () => {
  it('upgrades /r/<peerId>/ws with the tab token in the subprotocol and echoes the marker, never the token', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      assert.equal(socket.protocol, 'remotecli-tab');
      assert.ok(!socket.protocol.includes(h.tabToken));
      const stream = await h.nextStream();
      assert.equal(stream.open.kind, 'ws');
      assert.deepEqual(stream.open.kind === 'ws' ? stream.open.meta : null, { path: '/ws' });
      socket.close();

      // Legacy subprotocol fallback for rolling upgrades
      const legacySocket = await h.openTab({ protocols: ['cloudcli-tab', h.tabToken] });
      assert.equal(legacySocket.protocol, 'cloudcli-tab');
      legacySocket.close();
    });
  });

  it('opens a shell stream for /r/<peerId>/shell', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 0 }, async (h) => {
      const socket = await h.openTab({ channel: 'shell' });
      const stream = await h.nextStream();
      assert.deepEqual(stream.open.kind === 'ws' ? stream.open.meta : null, { path: '/shell' });
      socket.close();
    });
  });

  it('never puts the token, the query or the subprotocol on the stream it opens', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab({ query: '?token=abc&x=1' });
      const stream = await h.nextStream();
      assert.ok(!JSON.stringify(stream.open).includes(h.tabToken));
      assert.ok(!JSON.stringify(stream.open).includes('abc'));
      assert.ok(!JSON.stringify(stream.open).includes('cloudcli-tab'));
      socket.close();
    });
  });

  it('refuses a bad token, another peer\'s token, the main JWT, a missing or malformed subprotocol: 401', async () => {
    await withGatewayHarness({}, async (h) => {
      const path = `/r/${h.peerId}/ws`;
      assert.equal(await h.refusal(path, ['cloudcli-tab', 'garbage']), 401);
      assert.equal(await h.refusal(path, ['cloudcli-tab', h.issueFor(h.otherPeerId)]), 401);
      assert.equal(await h.refusal(path, ['cloudcli-tab', h.mainJwt]), 401, 'AC-25: the full JWT is not a tab token');
      assert.equal(await h.refusal(path), 401, 'no subprotocol');
      assert.equal(await h.refusal(path, [h.tabToken]), 401, 'token without the marker');
      assert.equal(await h.refusal(path, ['cloudcli-tab']), 401, 'marker without a token');
      assert.equal(await h.refusal(path, ['cloudcli-tab', h.tabToken, 'extra']), 401);
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('does not take the token from the URL', async () => {
    await withGatewayHarness({}, async (h) => {
      assert.equal(await h.refusal(`/r/${h.peerId}/ws?token=${h.tabToken}`), 401);
      assert.equal(await h.refusal(`/r/${h.peerId}/ws?token=${h.mainJwt}`), 401);
    });
  });

  it('refuses unknown peers and paths: 404', async () => {
    await withGatewayHarness({}, async (h) => {
      assert.equal(await h.refusal(`/r/${h.peerId}/other`, ['cloudcli-tab', h.tabToken]), 404);
      assert.equal(await h.refusal(`/r/${h.peerId}/ws/extra`, ['cloudcli-tab', h.tabToken]), 404);
      assert.equal(await h.refusal(`/r/${'x'.repeat(70)}/ws`, ['cloudcli-tab', h.tabToken]), 404);
      h.registry.forget(h.peerId);
      assert.equal(await h.refusal(`/r/${h.peerId}/ws`, ['cloudcli-tab', h.tabToken]), 404);
    });
  });

  it('refuses the upgrade with 503 while the link is down, so the browser retries', async () => {
    await withGatewayHarness({ online: false }, async (h) => {
      assert.equal(await h.refusal(`/r/${h.peerId}/ws`, ['cloudcli-tab', h.tabToken]), 503);
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('regular sockets still accept only the main JWT: the tab token is refused, the JWT works (no regression)', async () => {
    await withGatewayHarness({}, async (h) => {
      assert.equal(await h.refusal(`/desktop-notifications?token=${h.tabToken}`), 401);
      assert.equal(await h.refusal('/desktop-notifications'), 401);
      const ok = await h.openRegular();
      assert.equal(ok.readyState, WebSocket.OPEN);
      ok.close();
    });
  });

  it('a regular /ws request with a main JWT is not a Remote request and /r never takes the main JWT even in the query', async () => {
    await withGatewayHarness({}, async (h) => {
      assert.equal(await h.refusal(`/r/${h.peerId}/ws?token=${h.mainJwt}`, ['cloudcli-tab', h.mainJwt]), 401);
    });
  });

  it('spaces /shell upgrades of one pairing by the minimum interval without refusing them, and leaves other pairings alone', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 400 }, async (h) => {
      const startedAt = Date.now();
      const first = await h.openTab({ channel: 'shell' });
      const firstAt = Date.now() - startedAt;
      const second = await h.openTab({ channel: 'shell' });
      const secondAt = Date.now() - startedAt;
      assert.ok(secondAt - firstAt >= 380, `second shell upgrade came ${secondAt - firstAt} ms after the first`);

      const otherStart = Date.now();
      const other = await h.openTab({ channel: 'shell', peerId: h.otherPeerId, token: h.issueFor(h.otherPeerId) });
      assert.ok(Date.now() - otherStart < 300, 'another pairing is not delayed');
      for (const socket of [first, second, other]) socket.close();
    });
  });

  it('the default /shell spacing is two seconds', async () => {
    await withGatewayHarness({}, async (h) => {
      const first = await h.openTab({ channel: 'shell' });
      const mark = Date.now();
      const second = await h.openTab({ channel: 'shell' });
      assert.ok(Date.now() - mark >= 1900, `waited ${Date.now() - mark} ms`);
      first.close();
      second.close();
    });
  });

  it('chat sockets are not throttled', async () => {
    await withGatewayHarness({}, async (h) => {
      const mark = Date.now();
      const a = await h.openTab();
      const b = await h.openTab();
      assert.ok(Date.now() - mark < 1500);
      a.close();
      b.close();
    });
  });
});

describe('Remote WebSocket bridging', () => {
  it('carries text and binary messages both ways, in order', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      const received: Array<{ text: string; binary: boolean }> = [];
      socket.on('message', (data, binary) => received.push({ text: (data as Buffer).toString(), binary }));

      socket.send('{"type":"chat.subscribe"}');
      socket.send(Buffer.from([1, 2, 3]));
      await waitFor(() => stream.sent.length === 2, 'browser messages');
      assert.equal(stream.sent[0].payload.toString(), '{"type":"chat.subscribe"}');
      assert.equal(stream.sent[0].binary, false);
      assert.deepEqual([...stream.sent[1].payload], [1, 2, 3]);
      assert.equal(stream.sent[1].binary, true);

      stream.message('{"type":"hello"}');
      stream.message(Buffer.from([9, 8]), true);
      await waitFor(() => received.length === 2, 'host messages');
      assert.deepEqual(received[0], { text: '{"type":"hello"}', binary: false });
      assert.equal(received[1].binary, true);
      socket.close();
    });
  });

  it('forwards the browser close to the Host (reserved codes become sendable ones) and untracks the connection', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      socket.close(1000, 'bye');
      await waitFor(() => stream.closed, 'stream closed');
      assert.deepEqual(stream.closeInfo, { code: 1000, reason: 'bye' });
      assert.equal(h.registry.closeConnections(), 0);

      const other = await h.openTab();
      const second = await h.nextStream(1);
      other.terminate(); // abnormal: the server sees 1006, which the mux cannot carry
      await waitFor(() => second.closed, 'second stream closed');
      assert.ok(second.closeInfo && second.closeInfo.code >= 1000 && second.closeInfo.code !== 1006, `sent ${second.closeInfo?.code}`);
    });
  });

  it('relays the Host close code to the browser', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      const gone = closed(socket);
      stream.end({ cause: 'peer-ws-close', code: 4000, reason: 'host done' });
      assert.deepEqual(await gone, { code: 4000, reason: 'host done' });
    });
  });

  it('closes the browser socket with 4403 on a policy refusal, 1013 when the link drops, 1011 otherwise', async () => {
    await withGatewayHarness({}, async (h) => {
      const expectations: Array<[Parameters<typeof h.link.streams[0]['end']>[0], number]> = [
        [{ cause: 'error', origin: 'peer', code: 'REMOTE_FORBIDDEN', message: 'no' }, 4403],
        [{ cause: 'link-down', reason: 'peer-down' }, 1013],
        [{ cause: 'error', origin: 'peer', code: 'REMOTE_QUOTA', message: 'q' }, 1013],
        [{ cause: 'error', origin: 'peer', code: 'REMOTE_UPSTREAM_AUTH', message: 'a' }, 1011],
        [{ cause: 'error', origin: 'peer', code: 'REMOTE_INTERNAL', message: 'i' }, 1011],
        [{ cause: 'peer-cancel' }, 1011],
      ];
      for (const [index, [end, code]] of expectations.entries()) {
        const socket = await h.openTab();
        const stream = await h.nextStream(index);
        const gone = closed(socket);
        stream.end(end);
        assert.equal((await gone).code, code, JSON.stringify(end));
      }
    });
  });

  it('a long Host close reason is cut to what a close frame can carry', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      const gone = closed(socket);
      stream.end({ cause: 'peer-ws-close', code: 1000, reason: 'x'.repeat(500) });
      const result = await gone;
      assert.equal(result.code, 1000);
      assert.ok(Buffer.byteLength(result.reason) <= 123);
    });
  });

  it('closes with 1013 when the link goes down between the verdict and the connection', async () => {
    await withGatewayHarness({}, async (h) => {
      const original = h.link.openStream.bind(h.link);
      h.link.openStream = (open, handlers) => {
        h.link.setSession(false);
        return original(open, handlers);
      };
      const socket = await h.openTab();
      assert.equal((await closed(socket)).code, 1013);
    });
  });

  it('a browser message over the mux limit closes the socket with 1009 and ends the stream', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      const gone = closed(socket);
      socket.send(Buffer.alloc(1024 * 1024 + 1, 1));
      assert.equal((await gone).code, 1009);
      await waitFor(() => stream.closed, 'stream ended');
    });
  });

  it('stops reading the browser while the stream cannot take more, and resumes', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      stream.pauseWrites();
      for (const text of ['one', 'two', 'three', 'four']) {
        socket.send(text);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(stream.sent.length, 0, `read ${stream.sent.length} while the stream was paused`);
      stream.resumeWrites();
      await waitFor(() => stream.sent.length === 4, 'all messages after resume');
      assert.deepEqual(stream.sent.map((entry) => entry.payload.toString()), ['one', 'two', 'three', 'four']);
      socket.close();
    });
  });

  it('cuts the stream (REMOTE_QUOTA) and closes the browser socket when the Host floods a browser that does not read', async () => {
    await withGatewayHarness({ receiveBudgetBytes: 256 * 1024 }, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      socket.pause(); // a browser that stopped reading
      const chunk = Buffer.alloc(64 * 1024, 5);
      for (let i = 0; i < 600 && !stream.closed; i += 1) {
        stream.message(chunk, true);
        if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.ok(stream.closed, 'the stream was cut once the unread bytes passed the budget');
      assert.equal(stream.failure?.code, 'REMOTE_QUOTA');
      socket.terminate();
    });
  });

  it('keeps the connection registered while open and ends it when the registry closes connections', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      const gone = closed(socket);
      assert.equal(h.registry.closeConnections(h.peerId, 4401, 'auth-changed'), 1);
      assert.equal((await gone).code, 4401);
      assert.ok(stream.calls.includes('cancel'));
    });
  });
});

describe('Remote WebSocket gateway: close codes and edge cases', () => {
  const idleGateway = (h: { registry: Parameters<typeof createRemoteWebSocketGateway>[0]['registry'] }) =>
    createRemoteWebSocketGateway({ tabs: { authenticate: () => ({ ok: false, reason: 'invalid' }) }, registry: h.registry });

  it('passes the browser close code to the Host, turning the ones that cannot be sent into 1000/1011', async () => {
    await withGatewayHarness({}, async (h) => {
      const expectations: Array<[number | undefined, number]> = [
        [undefined, 1000], // closed without a code: the browser reports 1005
        [1001, 1001],
        [4000, 4000],
      ];
      for (const [index, [sent, forwarded]] of expectations.entries()) {
        const socket = await h.openTab();
        const stream = await h.nextStream(index);
        if (sent === undefined) socket.close();
        else socket.close(sent, 'bye');
        await waitFor(() => stream.closeInfo !== null, 'the close to reach the Host');
        assert.equal(stream.closeInfo?.code, forwarded);
      }
    });
  });

  it('closes the browser with 1013 when the Host side is overloaded and 1011 when the stream was cancelled under it', async () => {
    await withGatewayHarness({}, async (h) => {
      const first = await h.openTab();
      const overloaded = await h.nextStream(0);
      const firstClosed = closed(first);
      overloaded.end({ cause: 'queue-overflow' });
      assert.deepEqual(await firstClosed, { code: 1013, reason: 'overloaded' });

      const second = await h.openTab();
      const cancelled = await h.nextStream(1);
      const secondClosed = closed(second);
      cancelled.end({ cause: 'local-cancel' });
      assert.equal((await secondClosed).code, 1011);
    });
  });

  it('offers the marker only when the browser asked for it', async () => {
    await withGatewayHarness({}, async (h) => {
      const gateway = idleGateway(h);
      assert.equal(gateway.selectProtocol(new Set(['remotecli-tab', 'token'])), 'remotecli-tab');
      assert.equal(gateway.selectProtocol(new Set(['cloudcli-tab', 'token'])), 'cloudcli-tab');
      assert.equal(gateway.selectProtocol(new Set(['token'])), false);
      assert.equal(gateway.owns('/r/anything'), true);
      assert.equal(gateway.owns('/ws'), false);
    });
  });

  it('closes a socket that reaches the connection handler without having passed the upgrade check', async () => {
    await withGatewayHarness({}, async (h) => {
      const closes: Array<[number, string]> = [];
      idleGateway(h).handleConnection({ close: (code: number, reason: string) => closes.push([code, reason]) } as unknown as WebSocket, {} as never);
      assert.deepEqual(closes, [[1008, 'unauthorized']]);
    });
  });

  it('answers 500 when the Remote upgrade check itself fails, and leaves regular paths to the stock check', async () => {
    const server = await serve((_req, res) => res.writeHead(404).end());
    const wss = createWebSocketServer(server.server, {
      verifyClient: { isPlatform: false, authenticateWebSocket: () => null },
      chat: {} as never,
      shell: {} as never,
      getPluginPort: (() => undefined) as never,
      remote: {
        owns: (pathname) => pathname.startsWith('/r/'),
        verifyUpgrade: () => Promise.reject(new Error('boom')),
        selectProtocol: () => false,
        handleConnection: () => undefined,
      },
    });
    const statusOf = (path: string, protocols: string[]): Promise<number> =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, protocols);
        socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.once('open', () => resolve(101));
        socket.once('error', () => undefined);
      });
    try {
      assert.equal(await statusOf('/r/x/ws', ['cloudcli-tab', 't']), 500);
      assert.equal(await statusOf('/ws', ['first', 'second']), 401, 'the stock JWT check still decides regular paths');
    } finally {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await server.close();
    }
  });
});
