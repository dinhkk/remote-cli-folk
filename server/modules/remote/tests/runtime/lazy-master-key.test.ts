/**
 * The master key is created when Remote is first USED, not when the server starts: a Local-only user gets no
 * `~/.cloudcli/remote-master.key` and no `remote.*` rows. Remote storage opens at start only when the key is
 * in the environment, the key file exists, or sealed data / a relay URL is already saved; otherwise the first
 * state-changing management call (saving relay settings, switching Accept on, starting a pairing, joining
 * one) opens it, and read-only calls answer from an empty state without creating anything.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import { getConnection, remoteConfigDb } from '@/modules/database/index.js';

import { RELAY_SECRET, RELAY_URL, withModuleRig, type ModuleRig } from '../support/remote-module-rig.js';

type Json = Record<string, unknown>;

const errorCode = (body: string): string | undefined => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

/** Runs against a module with NO master key in the environment and its key file at a temp path that does not exist yet. */
const withUnusedRemote = async (
  run: (rig: ModuleRig, keyFile: string) => Promise<void>,
  options: { skipStart?: boolean } = {},
): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-master-key-'));
  const keyFile = path.join(dir, 'remote-master.key');
  try {
    await withModuleRig(
      { skipStart: options.skipStart, env: { CLOUDCLI_REMOTE_MASTER_KEY: undefined, CLOUDCLI_REMOTE_MASTER_KEY_FILE: keyFile } },
      (rig) => run(rig, keyFile),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const remoteRows = (): Array<{ key: string }> =>
  getConnection().prepare("SELECT key FROM app_config WHERE key LIKE 'remote.%'").all() as Array<{ key: string }>;

describe('master key: created on first use, not at server start', () => {
  it('a plain start creates no key file and no remote.* rows', async () => {
    await withUnusedRemote(async (rig, keyFile) => {
      assert.equal(fs.existsSync(keyFile), false);
      assert.deepEqual(remoteRows(), []);
      assert.equal(fs.existsSync(path.dirname(keyFile)) && fs.readdirSync(path.dirname(keyFile)).length, 0, 'nothing was written next to it either');
      void rig;
    });
  });

  it('read-only calls answer from an empty state and still create nothing', async () => {
    await withUnusedRemote(async (rig, keyFile) => {
      assert.deepEqual((await rig.api('/relay-config')).json<Json>(), { url: '', hasSecret: false, masterKeySource: 'file' });
      const host = (await rig.api('/host/status')).json<Json>();
      assert.equal(host.acceptEnabled, false);
      assert.deepEqual(host.controllers, []);
      assert.deepEqual((host.relay as Json).state, 'stopped');
      assert.equal(host.approvalTimeoutMs, 55000);
      assert.deepEqual((await rig.api('/peers')).json<unknown[]>(), []);

      assert.equal((await rig.api('/host/pairings/nope')).status, 404);
      assert.equal((await rig.api('/peers/join/nope')).status, 404);
      assert.equal((await rig.api('/peers/nope/tab-token', { method: 'POST' })).status, 404);
      assert.equal((await rig.api('/peers/nope', { method: 'DELETE' })).status, 404);
      assert.equal((await rig.api('/host/pairings/nope', { method: 'DELETE', password: true })).status, 404);
      assert.equal((await rig.api('/host/controllers/nope/disconnect', { method: 'POST' })).status, 404);

      const off = await rig.api('/host/accept', { method: 'PUT', body: { enabled: false }, password: true });
      assert.equal(off.status, 200);
      assert.equal((off.json<Json>()).acceptEnabled, false);
      assert.equal((await rig.api('/host/accept', { method: 'PUT', body: { enabled: 'yes' }, password: true })).status, 400);

      assert.equal(fs.existsSync(keyFile), false, 'reads and no-op writes must not create the key');
      assert.deepEqual(remoteRows(), []);
    });
  });

  it('saving the relay settings opens the storage: the key file and the key id appear, and the settings are kept', async () => {
    await withUnusedRemote(async (rig, keyFile) => {
      const saved = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: RELAY_SECRET }, password: true });
      assert.equal(saved.status, 200, saved.text());
      assert.equal(fs.existsSync(keyFile), true);
      assert.ok(remoteRows().some((row) => row.key === 'remote.master_key_id'));
      assert.deepEqual((await rig.api('/relay-config')).json<Json>(), { url: RELAY_URL, hasSecret: true, masterKeySource: 'file' });
      assert.ok(!saved.text().includes(RELAY_SECRET));
    });
  });

  const needRelay: Array<[string, string, Record<string, unknown> | undefined, boolean]> = [
    ['switching Accept on', 'PUT /host/accept', { enabled: true }, true],
    ['starting a Host pairing', 'POST /host/pairings/start', undefined, true],
    ['joining a Host', 'POST /peers/join', { code: 'ABCD-EFGH', deviceName: 'Phone' }, false],
  ];
  for (const [label, route, body, password] of needRelay) {
    it(`${label} without saved relay settings is refused (400 REMOTE_NOT_CONFIGURED) and creates no master key`, async () => {
      await withUnusedRemote(async (rig, keyFile) => {
        const [method, ...rest] = route.split(' ');
        const response = await rig.api(rest.join(' '), { method, body, password });
        assert.equal(response.status, 400, response.text());
        assert.equal(errorCode(response.text()), 'REMOTE_NOT_CONFIGURED');
        assert.equal(fs.existsSync(keyFile), false, 'a refused call must not leave a key file behind');
        assert.deepEqual(remoteRows(), [], 'nor any remote.* row');
      });
    });
  }

  for (const [label, route, body, password] of needRelay) {
    it(`${label} with a relay URL but no secret saved is still refused (400 REMOTE_NOT_CONFIGURED) and creates no master key`, async () => {
      await withUnusedRemote(async (rig, keyFile) => {
        rig.config.setRelayUrl(RELAY_URL); // saved after the server started: the storage is still closed
        const [method, ...rest] = route.split(' ');
        const response = await rig.api(rest.join(' '), { method, body, password });
        assert.equal(response.status, 400, response.text());
        assert.equal(errorCode(response.text()), 'REMOTE_NOT_CONFIGURED');
        assert.equal(fs.existsSync(keyFile), false, 'the URL alone is not a configured relay');
        assert.deepEqual(remoteRows().map((row) => row.key), ['remote.relay_url'], 'only the URL the test saved');
      });
    });
  }

  it('a settings table that cannot be read refuses the call and writes nothing to the data directory; Remote is not blocked afterwards', async () => {
    await withUnusedRemote(async (rig, keyFile) => {
      const dataDirectory = path.dirname(keyFile);
      const unreadable = mock.method(remoteConfigDb, 'get', () => {
        throw new Error('database is locked');
      });
      try {
        for (const [, route, body, password] of needRelay) {
          const [method, ...rest] = route.split(' ');
          const refused = await rig.api(rest.join(' '), { method, body, password });
          assert.equal(refused.status, 409, refused.text());
          assert.equal(errorCode(refused.text()), 'REMOTE_START_FAILED');
          assert.ok(!refused.text().includes('locked'), 'the database error text is not echoed');
        }
        assert.equal(fs.existsSync(keyFile), false, 'no key file');
        assert.deepEqual(fs.readdirSync(dataDirectory), [], 'nothing at all in the data directory (no temp file either)');
        assert.deepEqual(remoteRows(), [], 'no remote.* row');
      } finally {
        unreadable.mock.restore();
      }
      // The database recovered: the same call gets the normal answer instead of a failure stuck for the process.
      const recovered = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true }, password: true });
      assert.equal(recovered.status, 400, recovered.text());
      assert.equal(errorCode(recovered.text()), 'REMOTE_NOT_CONFIGURED');
    });
  });

  it('after the relay settings are saved the same calls reach the real service (the storage opened with the save)', async () => {
    await withUnusedRemote(async (rig, keyFile) => {
      assert.equal((await rig.api('/host/pairings/start', { method: 'POST', password: true })).status, 400);
      assert.equal(fs.existsSync(keyFile), false);
      const saved = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: RELAY_SECRET }, password: true });
      assert.equal(saved.status, 200, saved.text());
      assert.equal(fs.existsSync(keyFile), true);
      const started = await rig.api('/host/pairings/start', { method: 'POST', password: true });
      assert.equal(started.status, 200, started.text());
      assert.ok(started.json<Json>().code);
    });
  });

  it('a key file that already exists opens Remote at start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-master-key-existing-'));
    const keyFile = path.join(dir, 'remote-master.key');
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('base64')}\n`);
    try {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_MASTER_KEY: undefined, CLOUDCLI_REMOTE_MASTER_KEY_FILE: keyFile } }, async () => {
        assert.ok(remoteRows().some((row) => row.key === 'remote.master_key_id'), 'the storage was opened by start()');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the key in the environment opens Remote at start and is reported as the source', async () => {
    await withModuleRig({}, async (rig) => {
      assert.ok(remoteRows().some((row) => row.key === 'remote.master_key_id'));
      assert.equal((await rig.api('/relay-config')).json<Json>().masterKeySource, 'env');
    });
  });

  it('a saved relay URL (even without a secret) opens Remote at start', async () => {
    await withUnusedRemote(
      async (rig, keyFile) => {
        rig.config.setRelayUrl(RELAY_URL);
        rig.module.start();
        assert.ok(remoteRows().some((row) => row.key === 'remote.master_key_id'));
        assert.equal(fs.existsSync(keyFile), true);
      },
      { skipStart: true },
    );
  });

  it('sealed data with no key anywhere still fails closed (409 MASTER_KEY_MISMATCH) and never creates a new key', async () => {
    await withUnusedRemote(
      async (rig, keyFile) => {
        rig.config.setRelayUrl(RELAY_URL);
        rig.config.setRelaySecret(RELAY_SECRET); // sealed with the rig's own key, which the module under test does not have
        rig.module.start();
        const response = await rig.api('/relay-config');
        assert.equal(response.status, 409);
        assert.equal(errorCode(response.text()), 'MASTER_KEY_MISMATCH');
        assert.equal(fs.existsSync(keyFile), false);
      },
      { skipStart: true },
    );
  });

  it('a transient failure to open the storage on a call is retried by the next call (the cause went away): Remote is not blocked until restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-master-key-transient-'));
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const keyFile = path.join(blocker, 'remote-master.key');
    try {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_MASTER_KEY: undefined, CLOUDCLI_REMOTE_MASTER_KEY_FILE: keyFile } }, async (rig) => {
        const save = { method: 'PUT', body: { url: RELAY_URL, secret: RELAY_SECRET }, password: true };
        const failed = await rig.api('/relay-config', save);
        assert.equal(failed.status, 409, failed.text());
        assert.equal(errorCode(failed.text()), 'REMOTE_START_FAILED');

        fs.rmSync(blocker); // the disk problem is fixed
        const retried = await rig.api('/relay-config', save);
        assert.equal(retried.status, 200, retried.text());
        assert.equal(fs.existsSync(keyFile), true);
        assert.deepEqual((await rig.api('/relay-config')).json<Json>(), { url: RELAY_URL, hasSecret: true, masterKeySource: 'file' });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a transient failure at server start is retried by the next management call instead of answering as an unused install', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-master-key-start-'));
    const keyFile = path.join(dir, 'remote-master.key');
    fs.mkdirSync(keyFile); // exists (so start() opens the storage) but cannot be read as a file
    try {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_MASTER_KEY: undefined, CLOUDCLI_REMOTE_MASTER_KEY_FILE: keyFile } }, async (rig) => {
        const failed = await rig.api('/relay-config');
        assert.equal(failed.status, 409, failed.text());
        assert.equal(errorCode(failed.text()), 'REMOTE_START_FAILED');

        fs.rmdirSync(keyFile);
        fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('base64')}\n`);
        const retried = await rig.api('/relay-config');
        assert.equal(retried.status, 200, retried.text());
        assert.equal(retried.json<Json>().masterKeySource, 'file');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure to create the key shows as REMOTE_START_FAILED on that call and afterwards, without taking the server down', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-master-key-blocked-'));
    // The key file's parent is a regular file, so creating it fails.
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const keyFile = path.join(blocker, 'remote-master.key');
    try {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_MASTER_KEY: undefined, CLOUDCLI_REMOTE_MASTER_KEY_FILE: keyFile } }, async (rig) => {
        const first = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: RELAY_SECRET }, password: true });
        assert.equal(first.status, 409, first.text());
        assert.equal(errorCode(first.text()), 'REMOTE_START_FAILED');
        const again = await rig.api('/relay-config');
        assert.equal(again.status, 409);
        assert.equal(errorCode(again.text()), 'REMOTE_START_FAILED');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
