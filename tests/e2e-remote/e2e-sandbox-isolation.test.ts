// AC-24/25, the server half of tab isolation, played by a hostile iframe simulation: whatever script runs in a
// tab only ever holds ONE tab token (for one peer), delivered through the Sec-WebSocket-Protocol / Authorization
// header rules. It must not reach the Controller's management API, another peer, the Host's credentials or a
// long-lived JWT. (The browser half, a real sandboxed iframe, is recorded with evidence in the m1 report.)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';

const decodeClaims = (jwt: string): Record<string, any> => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Record<string, any>;

describe('tab token isolation (hostile iframe simulation)', () => {
  let world: RemoteWorld;
  let second: HostileHost;
  let tokenA = '';
  let tokenB = '';

  const tabTokenFor = async (peerId: string): Promise<string> =>
    (await world.controller.api(`/api/remote/peers/${peerId}/tab-token`, { method: 'POST', body: {} })).json<{ tabToken: string }>().tabToken;

  before(async () => {
    world = await startWorld();
    second = await startHostileHost(world.relay, world.controller, 'second-host');
    tokenA = await tabTokenFor(world.peerId);
    tokenB = await tabTokenFor(second.peerId);
  });
  after(async () => {
    second?.stop();
    await world.stop();
  });

  it('a tab token is short-lived, typed, and worthless against the Controller\'s own API', async () => {
    const claims = decodeClaims(tokenA);
    assert.equal(claims.typ, 'remote-tab');
    assert.equal(claims.peerId, world.peerId);
    assert.ok(claims.exp - claims.iat <= 900, 'at most 15 minutes');
    for (const path of ['/api/auth/user', '/api/projects', '/api/remote/peers', '/api/remote/relay-config']) {
      const response = await world.controller.api(path, { token: tokenA });
      assert.equal(response.status, 401, `${path} must not accept a tab token`);
    }
    const ws = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', null).catch((error: { status?: number }) => error);
    assert.equal((ws as { status?: number }).status, 401, 'no token, no tab');
  });

  it('the token of peer A does not open peer B, over HTTP, WebSocket or the token endpoint', async () => {
    assert.equal((await world.viaRemote('/api/projects', { token: tokenA })).status, 200);
    const crossHttp = await world.controller.api(`/r/${second.peerId}/api/projects`, { token: tokenA });
    assert.equal(crossHttp.status, 401);
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, second.peerId, 'ws', tokenA), (error: { status?: number }) => error.status === 401);
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, second.peerId, 'shell', tokenA), (error: { status?: number }) => error.status === 401);
    // Each token keeps working for its own peer.
    assert.equal((await world.controller.api(`/r/${second.peerId}/api/projects`, { token: tokenB })).status, 200);
    // And a tab cannot mint tokens for itself or another peer.
    const mint = await world.controller.api(`/api/remote/peers/${second.peerId}/tab-token`, { method: 'POST', body: {}, token: tokenA });
    assert.equal(mint.status, 401);
  });

  it('accepts the token only in the Authorization header or the subprotocol, never in the URL', async () => {
    const queryHttp = await world.controller.api(`/r/${world.peerId}/api/projects?token=${tokenA}`, { token: null });
    assert.equal(queryHttp.status, 401);
    const queryWs = await new Promise<number | string>((resolve) => {
      import('ws').then(({ WebSocket }) => {
        const socket = new WebSocket(`${world.controller.baseUrl.replace(/^http/, 'ws')}/r/${world.peerId}/ws?token=${tokenA}`);
        socket.once('open', () => {
          socket.close();
          resolve('open');
        });
        socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.once('error', () => resolve('error'));
      }, () => resolve('import-error'));
    });
    assert.notEqual(queryWs, 'open', 'a token in the URL must not open a tab socket');
    // The subprotocol form works and the server echoes the fixed name only.
    const ok = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', tokenA);
    assert.equal(ok.protocol, 'remotecli-tab');
    ok.close();
    // A token without the fixed marker name, or a marker without a token, does not authenticate.
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', null, { protocols: [tokenA] }), (error: { status?: number }) => error.status === 401);
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', null, { protocols: ['remotecli-tab'] }), (error: { status?: number }) => error.status === 401);
  });

  it('exposes no long-lived credential: /api/auth/* is answered locally or refused, and Host answers carry no JWT', async () => {
    const user = await world.viaRemote('/api/auth/user', { token: tokenA });
    assert.equal(user.status, 200);
    assert.deepEqual(Object.keys(user.json<{ user: object }>().user).sort(), ['id', 'username']);
    for (const [method, path] of [
      ['POST', '/api/auth/refresh'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/logout-all'],
      ['POST', '/api/auth/register'],
    ] as const) {
      const response = await world.viaRemote(path, { method, token: tokenA, body: {} });
      assert.equal(response.status, 403, `${path}: ${response.status}`);
    }
    const jwtLike = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
    for (const path of ['/api/projects', '/api/user/preferences', '/api/providers/sessions/recent', '/api/auth/status']) {
      const response = await world.viaRemote(path, { token: tokenA });
      assert.equal(jwtLike.test(response.text), false, `${path} body carries a JWT`);
      const headers = JSON.stringify([...response.headers.entries()]);
      assert.equal(jwtLike.test(headers), false, `${path} headers carry a JWT`);
      assert.equal(response.headers.get('x-refreshed-token'), null);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  });

  it('serves the target page with a CSP that limits what its scripts may talk to (contracts section 3)', async () => {
    const plain = await fetch(`${world.controller.baseUrl}/`);
    // The Local page carries the main-page policy (own-origin scripts and connections), never the tab policy.
    const host = new URL(world.controller.baseUrl).host;
    const plainCsp = plain.headers.get('content-security-policy') ?? '';
    // blob: only while plugins are on (a Local plugin's module is imported from a blob URL).
    const pluginBlob = process.env.REMOTECLI_PLUGINS_DISABLED === '1' ? '' : ' blob:';
    assert.match(plainCsp, new RegExp(`(^|; )script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*${pluginBlob}(;|$)`), 'the Local page allows only its own and hashed scripts');
    assert.ok(plainCsp.includes(`connect-src 'self' ws://${host} wss://${host}`), plainCsp);
    assert.ok(!/default-src|form-action/.test(plainCsp), 'the Local page does not get the tab policy');
    const target = await fetch(`${world.controller.baseUrl}/?target=${world.peerId}`);
    assert.equal(target.status, 200);
    const csp = target.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.ok(csp.includes(`connect-src 'self' ws://${host} wss://${host}`), csp);
    assert.ok(!/connect-src[^;]*(https?:|wss?:)(\s|;|$)/.test(csp), 'no open scheme in connect-src');
    assert.match(csp, /form-action 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline scripts are allowed by hash, never by unsafe-inline');
    assert.ok(!/script-src[^;]*blob:/.test(csp), 'the tab page never allows blob: scripts');
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(csp, /object-src 'none'/);
    // Assets do not carry it (they are fetched as module scripts from the opaque origin).
    const asset = await fetch(`${world.controller.baseUrl}/favicon.svg`);
    assert.equal(asset.headers.get('content-security-policy'), null);
  });

  it('answers a cross-origin preflight for the proxy the way a sandboxed (opaque-origin) tab needs, without credentials', async () => {
    const preflight = await fetch(`${world.controller.baseUrl}/r/${world.peerId}/api/projects`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.ok(preflight.status < 300, `preflight ${preflight.status}`);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.notEqual(preflight.headers.get('access-control-allow-credentials'), 'true');
  });
});
