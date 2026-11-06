// AC-26: the Host is untrusted. A Host (here: a hand-made peer on the real relay, paired with a real
// Controller server) that answers with refreshed tokens, cookies, auth markers, 401s, redirects or script
// content must not be able to log the Controller's user out, plant cookies in the Controller origin or
// run script there. The other direction too: nothing of the Controller's credentials reaches the Host.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { configureRelay } from './support/e2e-world.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';
import { type E2eRelay, startE2eRelay } from './support/e2e-relay.js';

describe('a hostile Host cannot leak credentials, cookies or script into the Controller', () => {
  let relay: E2eRelay;
  let controller: E2eServer;
  let host: HostileHost;
  let token = '';

  const get = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    controller.api(`/r/${host.peerId}${path}`, { ...init, token });

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

  it('drops X-Refreshed-Token, Set-Cookie, auth markers and the Host CSP/CORS headers from a JSON answer', async () => {
    host.respond(({ stream }) => {
      stream.sendResponse({
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-refreshed-token': 'forged-long-lived-token',
          'set-cookie': 'session=evil; Path=/; HttpOnly',
          'x-auth-error': 'invalid-token',
          'www-authenticate': 'Bearer realm="evil"',
          'access-control-allow-origin': 'https://evil.example',
          'access-control-allow-credentials': 'true',
          'content-security-policy': "default-src *",
          'strict-transport-security': 'max-age=0',
          'clear-site-data': '"cookies", "storage"',
          'refresh': '0; url=https://evil.example',
          'link': '<https://evil.example>; rel=preload',
          'x-request-id': 'kept-123',
        },
      });
      stream.writeBody(Buffer.from('{"ok":true}'), true);
    });
    const response = await get('/api/projects');
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"ok":true}');
    for (const name of ['x-refreshed-token', 'set-cookie', 'x-auth-error', 'www-authenticate', 'access-control-allow-credentials', 'strict-transport-security', 'clear-site-data', 'refresh', 'link']) {
      assert.equal(response.headers.get(name), null, `${name} must not be forwarded`);
    }
    assert.notEqual(response.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.notEqual(response.headers.get('content-security-policy'), 'default-src *');
    assert.equal(response.headers.get('x-request-id'), 'kept-123');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  for (const status of [401, 403]) {
    it(`a Host answering ${status} reaches the browser as a 502 without any auth marker (the tab never "logs out")`, async () => {
      host.respond(({ stream }) => {
        stream.sendResponse({ status, headers: { 'content-type': 'application/json', 'x-auth-error': 'invalid-token' } });
        stream.writeBody(Buffer.from('{"error":"Invalid token."}'), true);
      });
      const response = await get('/api/projects');
      assert.notEqual(response.status, 401, 'a 401 from the Host would make the client end the Local session');
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('x-auth-error'), null);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REMOTE_UPSTREAM_AUTH');
    });
  }

  it('does not follow or forward a redirect to another site', async () => {
    host.respond(({ stream }) => {
      stream.sendResponse({ status: 302, headers: { location: 'https://evil.example/steal', 'content-type': 'text/html' } });
      stream.writeBody(Buffer.from(''), true);
    });
    const response = await fetch(`${controller.baseUrl}/r/${host.peerId}/api/projects`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
    assert.equal(response.headers.get('location'), null);
  });

  it('serves non-JSON Host content sandboxed: nosniff and a CSP that forbids script', async () => {
    host.respond(({ stream }) => {
      stream.sendResponse({ status: 200, headers: { 'content-type': 'text/html' } });
      stream.writeBody(Buffer.from('<script>fetch("/api/auth/user",{credentials:"include"})</script>'), true);
    });
    const response = await get('/api/assets/files/evil.html');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /\bsandbox\b/);
    assert.match(csp, /default-src 'none'/);
  });

  it('sends the Host only allow-listed request headers: no tab token, no cookie, no Origin, no forged forwarding headers', async () => {
    host.respond(({ stream }) => {
      stream.sendResponse({ status: 200, headers: { 'content-type': 'application/json' } });
      stream.writeBody(Buffer.from('{}'), true);
    });
    const before = host.requests.length;
    const response = await get('/api/projects', {
      headers: {
        cookie: 'session=controller-session',
        origin: 'https://controller.example',
        'x-forwarded-for': '203.0.113.9',
        'x-api-key': 'attacker-supplied',
        accept: 'application/json',
        'x-request-id': 'req-77',
      },
    });
    assert.equal(response.status, 200);
    const request = host.requests[before];
    assert.ok(request, 'the Host saw the request');
    const names = Object.keys(request.headers).map((name) => name.toLowerCase());
    for (const forbidden of ['authorization', 'cookie', 'origin', 'x-forwarded-for', 'x-api-key', 'host', 'referer']) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not reach the Host`);
    }
    assert.ok(!JSON.stringify(request.headers).includes(token), 'the tab token never leaves the Controller');
    assert.ok(!JSON.stringify(request.headers).includes(controller.jwt), 'the Controller JWT never leaves the Controller');
    assert.equal(request.headers['x-request-id'], 'req-77');
  });

  it('never sends the Host the tab token in the WebSocket open either', async () => {
    const { RemoteSocket } = await import('./support/e2e-browser-client.js');
    host.respondWs((stream) => {
      stream.setHandlers({});
    });
    const socket = await RemoteSocket.open(controller.baseUrl, host.peerId, 'ws', token);
    assert.equal(socket.protocol, 'cloudcli-tab', 'only the fixed subprotocol is echoed, never the token');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = host.wsOpens.at(-1);
    assert.ok(open, 'the Host saw the WebSocket open');
    assert.ok(!JSON.stringify(open).includes(token));
    socket.close();
  });
});
