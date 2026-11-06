import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/index.js';

import { MASTER_KEY_ENV } from '../../crypto/master-key.js';
import { SecretBoxError, createSecretBox } from '../../crypto/secret-box.js';
import { createRemoteConfigService, initializeRemoteStorage } from '../../storage/remote-storage.service.js';
import { withTempDatabase } from '../support/temp-database.js';

const KEY_A = Buffer.alloc(32, 0xaa).toString('base64');
const KEY_B = Buffer.alloc(32, 0xbb).toString('base64');
const rawValue = (key: string): string | undefined =>
  (getConnection().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined)?.value;

const expectBoxError = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof SecretBoxError && error.code === code);

const withKeyDir = (run: (keyFilePath: string) => void | Promise<void>) => async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-key-'));
  try {
    await run(path.join(directory, 'remote-master.key'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test('relay url is stored as a normalized wss origin', async () => {
  await withTempDatabase(() => {
    const config = createRemoteConfigService({ box: createSecretBox(Buffer.alloc(32, 1)) });
    assert.equal(config.getRelayUrl(), null);
    config.setRelayUrl('wss://relay.example.workers.dev/');
    assert.equal(config.getRelayUrl(), 'wss://relay.example.workers.dev');
    assert.equal(rawValue('remote.relay_url'), 'wss://relay.example.workers.dev');
    config.setRelayUrl('WSS://Relay.Example.dev:8443/ws');
    assert.equal(config.getRelayUrl(), 'wss://relay.example.dev:8443');
    config.setRelayUrl('ws://127.0.0.1:8787');
    assert.equal(config.getRelayUrl(), 'ws://127.0.0.1:8787');
  });
});

test('unsafe or malformed relay urls are rejected', async () => {
  await withTempDatabase(() => {
    const config = createRemoteConfigService({ box: createSecretBox(Buffer.alloc(32, 1)) });
    for (const bad of ['', 'relay.example', 'https://relay.example', 'ws://relay.example', 'wss://user:pw@relay.example', 'wss://relay.example/?x=1', 'wss://relay.example/#frag', 'not a url']) {
      assert.throws(() => config.setRelayUrl(bad), /relay url/i, JSON.stringify(bad));
    }
    assert.equal(config.getRelayUrl(), null);
  });
});

test('the relay secret is stored sealed, never in plain or encoded form, and reads back', async () => {
  await withTempDatabase(() => {
    const config = createRemoteConfigService({ box: createSecretBox(Buffer.alloc(32, 1)) });
    assert.equal(config.hasRelaySecret(), false);
    assert.equal(config.getRelaySecret(), null);

    const secret = 'super-secret-relay-value-123';
    config.setRelaySecret(secret);
    assert.equal(config.hasRelaySecret(), true);
    assert.equal(config.getRelaySecret(), secret);

    const stored = rawValue('remote.relay_secret_sealed') as string;
    assert.ok(stored.length > 0);
    for (const form of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
      assert.ok(!stored.includes(form), 'the stored value contains the secret');
    }
    config.setRelaySecret('another-secret-value');
    assert.equal(config.getRelaySecret(), 'another-secret-value');
    assert.notEqual(rawValue('remote.relay_secret_sealed'), stored);

    config.clearRelaySecret();
    assert.equal(config.hasRelaySecret(), false);
    assert.equal(rawValue('remote.relay_secret_sealed'), undefined);
    assert.throws(() => config.setRelaySecret(''), /secret/i);
  });
});

test('a tampered or foreign-key relay secret fails loudly instead of returning garbage', async () => {
  await withTempDatabase(() => {
    const config = createRemoteConfigService({ box: createSecretBox(Buffer.alloc(32, 1)) });
    config.setRelaySecret('super-secret-relay-value-123');
    const stored = Buffer.from(rawValue('remote.relay_secret_sealed') as string, 'base64');
    stored[stored.length - 1] ^= 1;
    getConnection().prepare('UPDATE app_config SET value = ? WHERE key = ?').run(stored.toString('base64'), 'remote.relay_secret_sealed');
    expectBoxError(() => config.getRelaySecret(), 'decrypt-failed');

    const other = createRemoteConfigService({ box: createSecretBox(Buffer.alloc(32, 2)) });
    config.setRelaySecret('super-secret-relay-value-123');
    expectBoxError(() => other.getRelaySecret(), 'decrypt-failed');
  });
});

test('configuration reads throw when the database is broken (never read as "not configured")', async () => {
  await withTempDatabase(() => {
    const config = createRemoteConfigService({ box: createSecretBox(Buffer.alloc(32, 1)) });
    config.setRelayUrl('wss://relay.example');
    getConnection().exec('DROP TABLE app_config');
    assert.throws(() => config.getRelayUrl(), /no such table/);
    assert.throws(() => config.hasRelaySecret(), /no such table/);
    assert.throws(() => config.getRelaySecret(), /no such table/);
  });
});

test('initializeRemoteStorage resolves the master key once from the env, scrubs it and wires the services', async () => {
  await withTempDatabase(withKeyDir((keyFilePath) => {
    const env: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: KEY_A };
    const storage = initializeRemoteStorage({ env, keyFilePath });
    assert.equal(storage.keySource, 'env');
    assert.equal(env[MASTER_KEY_ENV], undefined, 'child processes must not inherit the master key');
    assert.equal(fs.existsSync(keyFilePath), false, 'no key file is written when the env key is used');

    storage.config.setRelaySecret('relay-secret-value-1');
    assert.equal(rawValue('remote.master_key_id'), storage.keyId, 'the key id is recorded');
    assert.equal(storage.pairings.listPairings().length, 0);
    const pairing = storage.pairings.insertPairing({ role: 'host', peerName: 'x', k: Buffer.alloc(32, 7), relayUrl: 'wss://relay.example' });
    assert.ok(storage.pairings.openPairingKey(pairing.id).equals(Buffer.alloc(32, 7)));
  }));
});

test('without an env key the key file is created once and reused; the same key is used on restart', async () => {
  await withTempDatabase(withKeyDir((keyFilePath) => {
    const first = initializeRemoteStorage({ env: {}, keyFilePath });
    assert.equal(first.keySource, 'file');
    assert.equal(fs.existsSync(keyFilePath), true);
    first.config.setRelaySecret('relay-secret-value-1');

    const second = initializeRemoteStorage({ env: {}, keyFilePath });
    assert.equal(second.keyId, first.keyId);
    assert.equal(second.config.getRelaySecret(), 'relay-secret-value-1');
  }));
});

test('a changed master key with sealed data present is MASTER_KEY_MISMATCH and creates nothing new', async () => {
  await withTempDatabase(withKeyDir((keyFilePath) => {
    initializeRemoteStorage({ env: { [MASTER_KEY_ENV]: KEY_A }, keyFilePath }).config.setRelaySecret('relay-secret-value-1');
    expectBoxError(() => initializeRemoteStorage({ env: { [MASTER_KEY_ENV]: KEY_B }, keyFilePath }), 'MASTER_KEY_MISMATCH');
    expectBoxError(() => initializeRemoteStorage({ env: {}, keyFilePath }), 'MASTER_KEY_MISMATCH');
    assert.equal(fs.existsSync(keyFilePath), false, 'a replacement key must never be generated while sealed data exists');
  }));
});

test('a lost key file with sealed pairings is MASTER_KEY_MISMATCH, not a silent new key', async () => {
  await withTempDatabase(withKeyDir((keyFilePath) => {
    const first = initializeRemoteStorage({ env: {}, keyFilePath });
    first.pairings.insertPairing({ role: 'host', peerName: 'x', k: Buffer.alloc(32, 9), relayUrl: 'wss://relay.example' });
    fs.rmSync(keyFilePath);
    expectBoxError(() => initializeRemoteStorage({ env: {}, keyFilePath }), 'MASTER_KEY_MISMATCH');
    closeConnection();
  }));
});

test('a set-but-malformed master key variable is still removed from the environment before the error', async () => {
  await withTempDatabase(withKeyDir((keyFilePath) => {
    for (const bad of ['"' + KEY_A + '"', 'not-base64!!', '', Buffer.alloc(16).toString('base64')]) {
      const env: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: bad };
      expectBoxError(() => initializeRemoteStorage({ env, keyFilePath }), 'MASTER_KEY_INVALID');
      assert.equal(env[MASTER_KEY_ENV], undefined, `child processes must not inherit ${JSON.stringify(bad.slice(0, 8))}`);
    }
    assert.equal(fs.existsSync(keyFilePath), false);
  }));
});

test('initializeRemoteStorage fails closed when the database itself cannot be read (no key is generated)', async () => {
  await withTempDatabase(withKeyDir((keyFilePath) => {
    getConnection().exec('DROP TABLE app_config');
    assert.throws(() => initializeRemoteStorage({ env: {}, keyFilePath }), /no such table/);
    assert.equal(fs.existsSync(keyFilePath), false, 'an unreadable database must never lead to a freshly generated key');
  }));
});
