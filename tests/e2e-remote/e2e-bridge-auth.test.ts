// The Host bridge authenticates itself against the REAL auth middleware of a real Host server (no Express
// stand-in): chat, HTTP and WebSocket requests from a Controller are answered 200, not 401/502 (AC-18/26,
// contracts section 3). A Host with API_KEY keeps working; a Controller with API_KEY or in platform mode
// refuses to enable Remote (REMOTE_UNSUPPORTED_MODE); `/api/remote/*` is unreachable from a tab (AC-33).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { startE2eServer } from './support/e2e-server.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';
import { sleep } from './support/e2e-util.js';

const API_KEY = 'e2e-api-key-0123456789abcdef';

describe('bridge authentication against the real Host middleware', () => {
  let world: RemoteWorld;
  let token = '';
  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
  });
  after(async () => {
    await world.stop();
  });

  it('answers HTTP requests of the UI with 200 from the Host database', async () => {
    for (const path of ['/api/projects', '/api/providers/sessions/recent', '/api/user/drafts']) {
      const response = await world.viaRemote(path, { token });
      assert.equal(response.status, 200, `${path}: ${response.text.slice(0, 200)}`);
    }
    const created = await world.viaRemote('/api/providers/sessions', {
      method: 'POST',
      token,
      body: { provider: 'claude', projectPath: world.host.home, initialMessage: 'bridge' },
    });
    assert.equal(created.status, 201, created.text);
    // The row really lives in the Host's database: the Host sees it with its own login.
    const sessionId = created.json<{ data: { sessionId: string } }>().data.sessionId;
    const onHost = await world.host.api(`/api/providers/sessions/${sessionId}`);
    assert.equal(onHost.status, 200);
  });

  it('answers the chat WebSocket and the shell WebSocket through the same middleware', async () => {
    const chat = await world.openChat(token);
    assert.equal(chat.protocol, 'cloudcli-tab');
    const sessionId = await world.createSession(token);
    chat.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    const subscribed = await chat.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    assert.equal(subscribed.sessionId, sessionId);
    chat.close();

    const shell = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token);
    await sleep(1000);
    assert.equal(shell.closed, null, 'the shell socket stays open after the Host accepted the upgrade');
    shell.close();
  });

  it('refuses what the allow-list does not offer, locally on the Controller and again on the Host', async () => {
    for (const [method, path] of [
      ['POST', '/api/auth/refresh'],
      ['POST', '/api/auth/logout-all'],
      ['GET', '/api/settings/api-keys'],
      ['GET', '/api/remote/relay-config'],
      ['PUT', '/api/remote/host/accept'],
      ['GET', '/api/system/update'],
      // Host administration the tab must not reach: provider login status, MCP definitions, Host preferences.
      ['GET', '/api/providers/claude/auth/status'],
      ['POST', '/api/providers/mcp/servers/global'],
      ['GET', '/api/providers/claude/mcp/servers'],
      ['GET', '/api/providers/claude/settings-permissions'],
      ['GET', '/api/user/preferences'],
      ['PATCH', '/api/user/preferences'],
      // A path nobody classified is refused as well (default deny).
      ['GET', '/api/does-not-exist'],
    ] as const) {
      const response = await world.viaRemote(path, { method, token, body: method === 'GET' ? undefined : {} });
      assert.equal(response.status, 403, `${method} ${path} -> ${response.status}`);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REMOTE_FORBIDDEN');
    }
    const wrongSocket = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', token).then((socket) => socket);
    wrongSocket.send({ type: 'init' }); // a shell message on the chat socket
    const closed = await wrongSocket.waitForClose(5000);
    assert.equal(closed.code, 4403);
  });

  it('keeps /api/remote/* off limits to a tab token and /r/* off limits to the full JWT (AC-25, AC-33)', async () => {
    const asTab = await world.controller.api('/api/remote/relay-config', { token });
    assert.equal(asTab.status, 401);
    const jwtOnProxy = await world.controller.api(`/r/${world.peerId}/api/projects`, { token: world.controller.jwt });
    assert.equal(jwtOnProxy.status, 401);
    const noPasswordStop = await world.controller.api('/api/remote/host/accept', { method: 'PUT', body: { enabled: false } });
    assert.equal(noPasswordStop.status, 401, 'switching Accept off also needs the password');
    assert.equal(noPasswordStop.json<{ error: { code: string } }>().error.code, 'AUTH_PASSWORD_REQUIRED');
    const otherSite = await world.controller.api('/api/remote/relay-config', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(otherSite.status, 403);
    const cookieOnly = await world.controller.api('/api/remote/relay-config', { token: null, headers: { cookie: `token=${world.controller.jwt}` } });
    assert.equal(cookieOnly.status, 401);
  });

  it('never exposes the relay secret, the master key or K through the management API or the process output', async () => {
    const config = await world.controller.api('/api/remote/relay-config');
    assert.equal(config.status, 200);
    assert.deepEqual(Object.keys(config.json()).sort(), ['hasSecret', 'masterKeySource', 'url']);
    for (const server of [world.host, world.controller]) {
      assert.equal(server.output().includes(world.relay.secret), false, `${server.name} output has the relay secret`);
      assert.equal(server.output().includes(token), false, `${server.name} output has a tab token`);
      assert.equal(server.output().includes(server.jwt), false, `${server.name} output has a JWT`);
    }
  });
});

describe('a Host with API_KEY set', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld({ hostEnv: { API_KEY } });
  });
  after(async () => {
    await world.stop();
  });

  it('is still served through the bridge (the bridge adds the Host x-api-key), and stays closed to unkeyed local callers', async () => {
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    chat.send({ type: 'chat.send', sessionId, content: 'e2e:echo hello', options: {} });
    await chat.waitFor((m) => m.kind === 'complete', 'complete');
    chat.close();
    const listing = await world.viaRemote('/api/projects', { token });
    assert.equal(listing.status, 200);
    const unkeyed = await world.host.api('/api/projects', { headers: { 'x-api-key': 'wrong-key' } });
    assert.equal(unkeyed.status, 401);
  });
});

describe('a Controller that cannot run Remote', () => {
  it('with API_KEY set refuses to be a Controller (409 REMOTE_UNSUPPORTED_MODE) and mounts no /r', async () => {
    const server = await startE2eServer({ name: 'keyed-controller', env: { API_KEY } });
    try {
      const peers = await server.api('/api/remote/peers');
      assert.equal(peers.status, 409, peers.text);
      assert.equal(peers.json<{ error: { code: string } }>().error.code, 'REMOTE_UNSUPPORTED_MODE');
      const join = await server.api('/api/remote/peers/join', { method: 'POST', body: { code: 'AAAA-BBBB', deviceName: 'x' } });
      assert.equal(join.status, 409);
      const proxy = await fetch(`${server.baseUrl}/r/anything/api/projects`, { headers: { authorization: 'Bearer x' } });
      assert.ok(!(proxy.headers.get('content-type') ?? '').includes('application/json'), '/r is not an API on this server');
      // It can still be a Host (the Host role supports API_KEY).
      const status = await server.api('/api/remote/host/status');
      assert.equal(status.status, 200);
    } finally {
      await server.stop();
    }
  });

  it('in platform mode refuses Remote altogether', async () => {
    // Platform mode skips token checks and takes the first user of the database: create it, then restart in that mode.
    const server = await startE2eServer({ name: 'platform' });
    try {
      await server.restart({ IS_PLATFORM: 'true', VITE_IS_PLATFORM: 'true' });
      for (const path of ['/api/remote/relay-config', '/api/remote/peers', '/api/remote/host/status']) {
        const response = await server.api(path, { token: 'any-token' });
        assert.equal(response.status, 409, `${path}: ${response.status} ${response.text.slice(0, 120)}`);
        assert.equal(response.json<{ error: { code: string } }>().error.code, 'REMOTE_UNSUPPORTED_MODE');
      }
    } finally {
      await server.stop();
    }
  });
});
