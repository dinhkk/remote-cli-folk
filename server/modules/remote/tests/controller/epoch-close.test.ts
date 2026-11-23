/**
 * "Log out everywhere" (contracts section 3): when the auth epoch changes, every regular WebSocket, every
 * `/r` WebSocket and every proxied HTTP/SSE stream ends within a second and the old tab tokens stop
 * working. Revocation also works with a pinned `JWT_SECRET`.
 * Runs on the real module, the real WebSocket gateway and a Host link on the in-process relay.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { open, send } from '../support/http-test-client.js';
import { until, withModuleRig, type ModuleRig } from '../support/remote-module-rig.js';

const ONE_SECOND = 1000;

const connect = (url: string, protocols?: string[], headers?: Record<string, string>): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { handshakeTimeout: 10_000, headers });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => reject(new Error(`refused:${res.statusCode}`)));
    socket.once('error', reject);
  });

const closedWithin = (socket: WebSocket, ms: number): Promise<number> =>
  new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => reject(new Error('the socket was not closed in time')), ms);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

type Live = { regular: WebSocket; tabSocket: WebSocket; stream: Awaited<ReturnType<typeof open>>; peerId: string; tabToken: string };

/** A Host that keeps every stream it is given open (an SSE-like response, an idle WebSocket). */
const openEverything = async (rig: ModuleRig): Promise<Live> => {
  await rig.configureRelay();
  const { record, host, tabToken } = rig.arrangePeer();
  host.onStream((stream, request) => {
    if (request.kind === 'http') {
      stream.setHandlers({
        onBody: (_chunk, fin) => {
          if (!fin) return;
          stream.sendResponse({ status: 200, headers: { 'content-type': 'text/event-stream' } });
          stream.writeBody(Buffer.from('data: first\n\n'), false);
        },
      });
    } else {
      stream.setHandlers({});
    }
  });
  host.start();
  // Listing the peers is what opens the Controller link.
  await until(async () => (await rig.api('/peers')).json<Array<{ state: string }>>()[0]?.state === 'online', 'the peer to come online');

  const regular = await connect(`ws://127.0.0.1:${rig.port}/desktop-notifications`, undefined, { cookie: `remotecli_session=${rig.jwt}`, origin: `http://127.0.0.1:${rig.port}` });
  const tabSocket = await connect(`ws://127.0.0.1:${rig.port}/r/${record.id}/ws`, ['cloudcli-tab', tabToken]);
  const stream = await open(rig.port, { path: `/r/${record.id}/api/projects`, headers: { authorization: `Bearer ${tabToken}` } });
  assert.equal(stream.status, 200);
  await new Promise<void>((resolve) => stream.res.once('data', () => resolve()));
  return { regular, tabSocket, stream, peerId: record.id, tabToken };
};

const streamEnded = (live: Live, ms: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the HTTP stream was not ended in time')), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    live.stream.res.once('close', done);
    live.stream.res.once('end', done);
    live.stream.res.once('error', done);
    live.stream.res.resume();
  });

describe('auth epoch change', () => {
  it('ends regular sockets, /r sockets and proxied streams within a second, and old tab tokens stop working', async () => {
    const previous = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      await withModuleRig({}, async (rig) => {
        const live = await openEverything(rig);
        const regularClosed = closedWithin(live.regular, ONE_SECOND);
        const tabClosed = closedWithin(live.tabSocket, ONE_SECOND);
        const streamClosed = streamEnded(live, ONE_SECOND);

        await rig.logoutAll();

        assert.equal(await regularClosed, 4401);
        assert.equal(await tabClosed, 4401);
        await streamClosed;

        const old = await send(rig.port, { path: `/r/${live.peerId}/api/auth/user`, headers: { authorization: `Bearer ${live.tabToken}` } });
        assert.equal(old.status, 401, 'a tab token of the previous epoch is refused');
        await assert.rejects(
          connect(`ws://127.0.0.1:${rig.port}/r/${live.peerId}/ws`, ['cloudcli-tab', live.tabToken]),
          /refused:401/,
        );
      });
    } finally {
      if (previous !== undefined) process.env.JWT_SECRET = previous;
    }
  });

  it('K-11: with JWT_SECRET pinned all browser sessions and Remote transports end', async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'p'.repeat(48);
    try {
      await withModuleRig({}, async (rig) => {
        const live = await openEverything(rig);
        const regularClosed = closedWithin(live.regular, ONE_SECOND);
        const tabClosed = closedWithin(live.tabSocket, ONE_SECOND);
        const streamClosed = streamEnded(live, ONE_SECOND);

        await rig.logoutAll();

        assert.equal(await tabClosed, 4401);
        await streamClosed;
        assert.equal(await regularClosed, 4401);
        assert.equal((await rig.api('/relay-config', {})).status, 401, 'the revoked session cannot call APIs');
      });
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });

  it('a socket opened after the change works with a fresh token', async () => {
    await withModuleRig({}, async (rig) => {
      const live = await openEverything(rig);
      await rig.logoutAll();
      await closedWithin(live.tabSocket, ONE_SECOND);
      await rig.relogin(); // the secret rotated with the epoch
      const fresh = (await rig.api(`/peers/${live.peerId}/tab-token`, { method: 'POST' })).json<{ tabToken: string }>().tabToken;
      const socket = await connect(`ws://127.0.0.1:${rig.port}/r/${live.peerId}/ws`, ['cloudcli-tab', fresh]);
      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.close();
    });
  });
});
