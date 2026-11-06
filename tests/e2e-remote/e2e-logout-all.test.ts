// "Log out everywhere" ends every Remote stream within a second and kills old tab tokens (AC-17..21 area,
// contracts section 3): chat and shell sockets and a long HTTP response through `/r`, on the Controller; and
// on the Host, every bridged stream plus the loopback tokens of the old secret.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { configureRelay, startWorld, type RemoteWorld } from './support/e2e-world.js';
import { startE2eRelay, type E2eRelay } from './support/e2e-relay.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';
import { sleep, waitUntil } from './support/e2e-util.js';

const logoutAll = async (server: E2eServer): Promise<number> =>
  (await server.api('/api/auth/logout-all', { method: 'POST', body: { password: server.password } })).status;

describe('logout-all on the Controller', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld();
  });
  after(async () => {
    await world.stop();
  });

  it('closes the chat and shell sockets within 1 s, refuses the old tab token and works again after a new login', async () => {
    const token = await world.tabToken();
    const chat = await world.openChat(token);
    const shell = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token);
    // A regular (non-Remote) socket of the same login must also die: the secret is rotated, JWT_SECRET is not pinned.
    const local = await new Promise<import('ws').WebSocket>((resolve, reject) => {
      void import('ws').then(({ WebSocket }) => {
        const socket = new WebSocket(`${world.controller.baseUrl.replace(/^http/, 'ws')}/ws?token=${world.controller.jwt}`);
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
    });
    let localClosedAt = 0;
    local.once('close', () => {
      localClosedAt = Date.now();
    });
    await sleep(300);

    const status = await logoutAll(world.controller);
    const finishedAt = Date.now();
    assert.equal(status, 200);

    const [chatClosed, shellClosed] = await Promise.all([chat.waitForClose(3000), shell.waitForClose(3000)]);
    const closedAt = Date.now();
    assert.ok(closedAt - finishedAt <= 1000, `streams closed ${closedAt - finishedAt} ms after logout-all`);
    assert.equal(chatClosed.code, 4401);
    assert.equal(shellClosed.code, 4401);
    await waitUntil(() => localClosedAt > 0, 'the regular chat socket to close', 3000);
    assert.ok(localClosedAt - finishedAt <= 1000);

    const old = await world.viaRemote('/api/projects', { token });
    assert.equal(old.status, 401, 'the old tab token is dead');
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', token), (error: { status?: number }) => error.status === 401);

    // The old JWT is dead as well; a fresh login gives a fresh tab token and the pairing still works.
    assert.equal((await world.controller.api('/api/remote/peers')).status, 401);
    await world.controller.relogin();
    const fresh = await world.tabToken();
    const reopened = await world.openChat(fresh);
    const sessionId = await world.createSession(fresh);
    reopened.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    await reopened.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed after re-login');
    reopened.close();
  });
});

describe('logout-all on the Host', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld();
  });
  after(async () => {
    await world.stop();
  });

  it('closes every bridged stream within 1 s; the next streams run with tokens of the new secret', async () => {
    const token = await world.tabToken();
    const chat = await world.openChat(token);
    const shell = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token);
    await sleep(500);

    assert.equal(await logoutAll(world.host), 200);
    const finishedAt = Date.now();
    await Promise.all([chat.waitForClose(3000), shell.waitForClose(3000)]);
    assert.ok(Date.now() - finishedAt <= 1500, 'bridged sockets closed promptly');

    // The Controller side is untouched: same tab token, new streams, answered by the Host's new secret.
    const listing = await world.viaRemote('/api/projects', { token });
    assert.equal(listing.status, 200, listing.text);
    const again = await world.openChat(token);
    const sessionId = await world.createSession(token);
    again.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    await again.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    again.close();
  });
});

describe('logout-all with a long HTTP response in flight', () => {
  let relay: E2eRelay;
  let controller: E2eServer;
  let host: HostileHost;
  before(async () => {
    relay = await startE2eRelay();
    controller = await startE2eServer({ name: 'controller' });
    await configureRelay(relay, controller);
    host = await startHostileHost(relay, controller);
  });
  after(async () => {
    host?.stop();
    await controller?.stop();
    await relay?.stop();
  });

  it('cuts a response that never ends (SSE-like) within 1 s', async () => {
    host.respond(({ stream }) => {
      stream.sendResponse({ status: 200, headers: { 'content-type': 'text/event-stream' } });
      stream.writeBody(Buffer.from('data: first\n\n'), false);
    });
    const token = (await controller.api(`/api/remote/peers/${host.peerId}/tab-token`, { method: 'POST', body: {} })).json<{ tabToken: string }>().tabToken;
    let loggedOutAt = 0;
    const outcome = await new Promise<{ endedAt: number; complete: boolean }>((resolve, reject) => {
      const request = http.get(`${controller.baseUrl}/r/${host.peerId}/api/providers/search/sessions?q=x`, { headers: { authorization: `Bearer ${token}` } }, (response) => {
        const done = (): void => resolve({ endedAt: Date.now(), complete: response.complete });
        response.on('close', done);
        response.on('error', done);
        response.once('data', () => {
          void logoutAll(controller).then(() => {
            loggedOutAt = Date.now();
          });
        });
      });
      request.on('error', reject);
    });
    assert.equal(outcome.complete, false, 'the response was cut, not finished');
    await waitUntil(() => loggedOutAt > 0, 'logout-all to answer', 5000);
    assert.ok(outcome.endedAt - loggedOutAt < 1000, `the stream ended ${outcome.endedAt - loggedOutAt} ms after logout-all answered`);
  });
});
