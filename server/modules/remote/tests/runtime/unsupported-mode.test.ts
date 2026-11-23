/**
 * Where Remote must not run (contracts section 1): the kill switch mounts and opens nothing; platform mode
 * and a Controller with `API_KEY` answer 409 `REMOTE_UNSUPPORTED_MODE`, never mount `/r` and never open a
 * link; a Host with `API_KEY` still works; a master key that changed is a status, not a crash. Also the
 * effective approval timeout the Host reports (FR-31), the CSP of `?target=` pages and the address the
 * Host bridge calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import express from 'express';

import { remoteConfigDb } from '@/modules/database/index.js';

import { MAIN_PAGE_CSP } from '../../runtime/main-page-security-headers.js';
import { createRemoteModule, resolveBridgeHost, TARGET_PAGE_CSP } from '../../runtime/remote.module.js';
import { MASTER_KEY, RELAY_SECRET, RELAY_URL, withModuleRig, type ModuleRig } from '../support/remote-module-rig.js';
import { send, serve } from '../support/http-test-client.js';

type Json = Record<string, unknown>;

const errorCode = (body: string): string | undefined => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

const fellThrough = async (rig: ModuleRig, path: string): Promise<boolean> => {
  const response = await send(rig.port, { path, headers: { authorization: `Bearer ${rig.jwt}` } });
  return response.status === 404 && response.text() === 'fell through';
};

describe('kill switch', () => {
  for (const value of ['1', 'true', 'TRUE']) {
    it(`CLOUDCLI_REMOTE_DISABLED=${value} mounts nothing, opens no link and leaves the master key alone`, async () => {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_DISABLED: value } }, async (rig) => {
        assert.equal(rig.module.enabled, false);
        assert.equal(rig.module.websocket, undefined);
        assert.ok(await fellThrough(rig, '/api/remote/relay-config'));
        assert.ok(await fellThrough(rig, '/r/some-peer/api/health'));
        const csp = await send(rig.port, { path: '/?target=abc' });
        assert.equal(csp.headers['content-security-policy'], undefined);
        assert.equal(rig.net.sockets.length, 0);
        assert.equal(remoteConfigDb.get('remote.master_key_id'), null, 'the master key was not even resolved');
      });
    });
  }

  it('is not triggered by 0, false or an empty value', async () => {
    for (const value of ['0', 'false', '']) {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_DISABLED: value } }, async (rig) => {
        assert.equal(rig.module.enabled, true);
        assert.equal((await rig.api('/relay-config')).status, 200);
      });
    }
  });
});

describe('platform mode', () => {
  it('answers 409 REMOTE_UNSUPPORTED_MODE everywhere on the management API, mounts no /r and no WebSocket gateway', async () => {
    await withModuleRig({ env: { VITE_IS_PLATFORM: 'true' } }, async (rig) => {
      for (const [method, path] of [['GET', '/relay-config'], ['GET', '/host/status'], ['GET', '/peers'], ['PUT', '/host/accept']] as const) {
        const response = await rig.api(path, { method, body: method === 'PUT' ? { enabled: true } : undefined, password: method === 'PUT' });
        assert.equal(response.status, 409, `${method} ${path}`);
        assert.equal(errorCode(response.text()), 'REMOTE_UNSUPPORTED_MODE');
      }
      assert.ok(await fellThrough(rig, '/r/some-peer/api/health'));
      assert.equal(rig.module.websocket, undefined);
      assert.equal(rig.net.sockets.length, 0);
    });
  });
});

describe('a Controller with API_KEY set', () => {
  const withApiKey = async (run: (rig: ModuleRig, key: Record<string, string>) => Promise<void>): Promise<void> => {
    const previous = process.env.API_KEY;
    process.env.API_KEY = 'a-secret-api-key';
    try {
      await withModuleRig({ env: { API_KEY: 'a-secret-api-key' } }, (rig) => run(rig, { 'x-api-key': 'a-secret-api-key' }));
    } finally {
      if (previous === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previous;
    }
  };

  it('cannot be a Controller: peers, joining and tab tokens are 409, /r is not mounted, no link is opened', async () => {
    await withApiKey(async (rig, key) => {
      rig.arrangePeer();
      assert.equal((await rig.api('/peers', { headers: key })).status, 409);
      const peers = await rig.api('/peers', { headers: key });
      assert.equal(errorCode(peers.text()), 'REMOTE_UNSUPPORTED_MODE');
      const join = await rig.api('/peers/join', { method: 'POST', body: { code: 'ABCD-EFGH', deviceName: 'Phone' }, headers: key });
      assert.equal(join.status, 409);
      const token = await rig.api('/peers/anything/tab-token', { method: 'POST', headers: key });
      assert.equal(token.status, 409);
      assert.equal(rig.module.websocket, undefined);
      assert.equal(rig.net.sockets.length, 0);
      const probe = await send(rig.port, { path: '/r/anything/api/health', headers: { authorization: `Bearer ${rig.jwt}`, ...key } });
      assert.equal(probe.text(), 'fell through');
    });
  });

  it('can still be a Host: the status and Accept work (the bridge adds the key itself)', async () => {
    await withApiKey(async (rig, key) => {
      const saved = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: RELAY_SECRET }, password: true, headers: key });
      assert.equal(saved.status, 200, saved.text());
      assert.equal((await rig.api('/host/status', { headers: key })).status, 200);
      const on = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true }, password: true, headers: key });
      assert.equal(on.status, 200, on.text());
      assert.equal(on.json<Json>().acceptEnabled, true);
    });
  });
});

describe('master key', () => {
  it('a changed master key is reported as 409 MASTER_KEY_MISMATCH, the server keeps running and nothing connects', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay(); // seals the relay secret under the first key and records its id
      rig.module.stop();

      const otherKey = Buffer.from(MASTER_KEY).fill(0x24).toString('base64');
      const app = express();
      const second = createRemoteModule({ appVersion: 'test', port: rig.port, env: { CLOUDCLI_REMOTE_MASTER_KEY: otherKey }, runtime: { socketFactory: rig.net.factory, clock: rig.clock } });
      second.mount(app);
      const server = await serve(app);
      try {
        second.start(); // must not throw
        for (const path of ['/api/remote/relay-config', '/api/remote/host/status', '/api/remote/peers']) {
          const response = await send(server.port, {
            path,
            headers: { cookie: `remotecli_session=${rig.jwt}`, 'x-remotecli-request': '1', 'sec-fetch-site': 'same-origin' },
          });
          assert.equal(response.status, 409, path);
          assert.equal(errorCode(response.text()), 'MASTER_KEY_MISMATCH');
        }
        const proxied = await send(server.port, { path: '/r/some-peer/api/projects', headers: { authorization: 'Bearer nope' } });
        assert.equal(proxied.status, 401, 'the tab-token check still comes first');
      } finally {
        second.stop();
        await server.close();
      }
    });
  });
});

describe('approval timeout reported by the Host', () => {
  const timeoutFor = async (value: string | undefined): Promise<unknown> => {
    let reported: unknown;
    await withModuleRig({ env: { CLAUDE_TOOL_APPROVAL_TIMEOUT_MS: value } }, async (rig) => {
      reported = (await rig.api('/host/status')).json<Json>().approvalTimeoutMs;
    });
    return reported;
  };

  it('defaults to 55000 and follows CLAUDE_TOOL_APPROVAL_TIMEOUT_MS', async () => {
    assert.equal(await timeoutFor(undefined), 55_000);
    assert.equal(await timeoutFor('300000'), 300_000);
    assert.equal(await timeoutFor('120000'), 120_000);
  });

  it('falls back to the default for a value that is not a number or is zero', async () => {
    assert.equal(await timeoutFor('soon'), 55_000);
    assert.equal(await timeoutFor('0'), 55_000);
  });
});

describe('pages served with ?target=', () => {
  it('carry the CSP that limits the tab to its own origin; other pages and assets do not', async () => {
    await withModuleRig({}, async (rig) => {
      const withTarget = await send(rig.port, { path: '/?target=peer-1' });
      assert.equal(withTarget.headers['content-security-policy'], TARGET_PAGE_CSP);
      assert.equal((await send(rig.port, { path: '/index.html?target=peer-1' })).headers['content-security-policy'], TARGET_PAGE_CSP);
      assert.equal((await send(rig.port, { path: '/settings?target=peer-1' })).headers['content-security-policy'], TARGET_PAGE_CSP);
      assert.equal((await send(rig.port, { path: '/' })).headers['content-security-policy'], MAIN_PAGE_CSP, 'the plain page has only the main-page policy');
      assert.equal((await send(rig.port, { path: '/assets/app.js?target=peer-1' })).headers['content-security-policy'], undefined);
    });
  });
});

describe('address the Host bridge calls', () => {
  it('is loopback unless the server is bound to one specific IP, which is then the only address that answers', () => {
    for (const bound of [undefined, '', '0.0.0.0', '::', '0:0:0:0:0:0:0:0', 'localhost', 'my-machine.local']) {
      assert.equal(resolveBridgeHost(bound), undefined, String(bound));
    }
    assert.equal(resolveBridgeHost('127.0.0.1'), '127.0.0.1');
    assert.equal(resolveBridgeHost('192.168.1.5'), '192.168.1.5');
    assert.equal(resolveBridgeHost('::1'), '::1');
    assert.equal(resolveBridgeHost(' 10.0.0.2 '), '10.0.0.2');
  });
});
