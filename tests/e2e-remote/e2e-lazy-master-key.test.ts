// A Local-only user never gets Remote artefacts: starting the server (and browsing the Remote settings) creates
// no master key file and no `remote.*` row. The key appears when Remote is first used, and from then on every
// start opens the storage. Real server processes on a throw-away data directory.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { startE2eRelay, type E2eRelay } from './support/e2e-relay.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';

const remoteRows = (server: E2eServer): string[] => {
  const db = new Database(server.dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT key FROM app_config WHERE key LIKE 'remote.%' ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
  } finally {
    db.close();
  }
};

describe('Remote is lazy: nothing is created until it is used', () => {
  let relay: E2eRelay;
  let server: E2eServer;
  let keyFile = '';

  before(async () => {
    relay = await startE2eRelay();
    server = await startE2eServer({ name: 'local-only' });
    keyFile = path.join(server.dataDir, 'remote-master.key');
  });
  after(async () => {
    await server?.stop();
    await relay?.stop();
  });

  it('a plain start (and a login) leaves no master key file and no remote.* rows', () => {
    assert.equal(existsSync(keyFile), false);
    assert.deepEqual(remoteRows(server), []);
  });

  it('looking at the Remote settings changes nothing on disk and shows an unused install', async () => {
    const config = (await server.api('/api/remote/relay-config')).json<{ url: string; hasSecret: boolean }>();
    assert.equal(config.url, '');
    assert.equal(config.hasSecret, false);
    const status = await server.api('/api/remote/host/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json<{ acceptEnabled: boolean }>().acceptEnabled, false);
    assert.deepEqual((await server.api('/api/remote/peers')).json<unknown[]>(), []);
    assert.equal(existsSync(keyFile), false);
    assert.deepEqual(remoteRows(server), []);
  });

  it('a restart of an unused server still creates nothing', async () => {
    await server.restart();
    await server.relogin();
    assert.equal(existsSync(keyFile), false);
    assert.deepEqual(remoteRows(server), []);
  });

  it('starting a pairing, joining one or switching Accept on without relay settings is refused and creates nothing', async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/api/remote/host/pairings/start', { password: server.password }],
      ['PUT', '/api/remote/host/accept', { enabled: true, password: server.password }],
      ['POST', '/api/remote/peers/join', { code: 'ABCD-EFGH', deviceName: 'Phone' }],
    ];
    for (const [method, path, body] of calls) {
      const refused = await server.api(path, { method, body });
      assert.equal(refused.status, 400, `${method} ${path}: ${refused.text}`);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'REMOTE_NOT_CONFIGURED');
    }
    assert.equal(existsSync(keyFile), false, 'a refused call must not create the master key');
    assert.deepEqual(remoteRows(server), []);
  });

  it('saving the relay settings creates the key and the rows; a restart then opens the storage by itself', async () => {
    const saved = await server.api('/api/remote/relay-config', { method: 'PUT', body: { url: relay.url, secret: relay.secret, password: server.password } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(existsSync(keyFile), true);
    assert.ok(remoteRows(server).includes('remote.master_key_id'));

    await server.restart();
    await server.relogin();
    const config = (await server.api('/api/remote/relay-config')).json<{ url: string; hasSecret: boolean }>();
    assert.equal(config.url, relay.url);
    assert.equal(config.hasSecret, true);
  });
});
