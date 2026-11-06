import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  MASTER_KEY_ENV,
  createAppConfigMasterKeyStore,
  resolveMasterKey,
  type MasterKeyStore,
} from '../../crypto/master-key.js';
import {
  SecretBoxError,
  computeMasterKeyId,
  createSecretBox,
  secretAad,
} from '../../crypto/secret-box.js';

const KEY = Buffer.alloc(32, 0x42);
const OTHER_KEY = Buffer.alloc(32, 0x43);
const AAD = secretAad('remote_pairings', 'k_sealed', 'pairing-1');

const expectBoxError = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SecretBoxError, `expected SecretBoxError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });

const withTempDir = async (run: (dir: string) => Promise<void> | void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-secret-box-'));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** In-memory MasterKeyStore with switches for the "already has sealed data" cases. */
const createMemoryStore = (initial: { keyId?: string | null; sealed?: boolean } = {}) => {
  const state = { keyId: initial.keyId ?? null, sealed: initial.sealed ?? false, writes: [] as string[] };
  const store: MasterKeyStore = {
    readKeyId: () => state.keyId,
    writeKeyId: (id) => {
      state.keyId = id;
      state.writes.push(id);
    },
    hasSealedData: () => state.sealed,
  };
  return { store, state };
};

// ---------------------------------------------------------------------------
// seal / open
// ---------------------------------------------------------------------------

test('seal then open returns the original bytes for strings and buffers', () => {
  const box = createSecretBox(KEY);
  assert.deepEqual(box.open(box.seal('relay-secret', AAD), AAD), Buffer.from('relay-secret'));
  const binary = crypto.randomBytes(64);
  assert.deepEqual(box.open(box.seal(binary, AAD), AAD), binary);
  assert.deepEqual(box.open(box.seal('', AAD), AAD), Buffer.alloc(0));
});

test('blob layout is [version 1][nonce 12][ciphertext][tag 16]', () => {
  const blob = createSecretBox(KEY).seal(Buffer.alloc(10), AAD);
  assert.equal(blob[0], 1);
  assert.equal(blob.length, 1 + 12 + 10 + 16);
});

test('sealing the same value twice gives different blobs (random nonce)', () => {
  const box = createSecretBox(KEY);
  const first = box.seal('same', AAD);
  const second = box.seal('same', AAD);
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(first.subarray(1, 13), second.subarray(1, 13));
});

test('a wrong key, flipped nonce/ciphertext/tag byte, or truncation fails to open', () => {
  const blob = createSecretBox(KEY).seal('payload', AAD);
  expectBoxError(() => createSecretBox(OTHER_KEY).open(blob, AAD), 'decrypt-failed');
  for (const index of [1, 13, blob.length - 1]) {
    const tampered = Buffer.from(blob);
    tampered[index] ^= 0x01;
    expectBoxError(() => createSecretBox(KEY).open(tampered, AAD), 'decrypt-failed');
  }
  expectBoxError(() => createSecretBox(KEY).open(blob.subarray(0, blob.length - 1), AAD), 'decrypt-failed');
});

test('an unknown version byte is refused explicitly', () => {
  const blob = createSecretBox(KEY).seal('payload', AAD);
  const future = Buffer.from(blob);
  future[0] = 2;
  expectBoxError(() => createSecretBox(KEY).open(future, AAD), 'unsupported-version');
});

test('blobs too short to contain a nonce and tag are invalid', () => {
  const box = createSecretBox(KEY);
  expectBoxError(() => box.open(Buffer.alloc(0), AAD), 'invalid-blob');
  expectBoxError(() => box.open(Buffer.from([1, 2, 3]), AAD), 'invalid-blob');
  expectBoxError(() => box.open('not-a-buffer' as unknown as Buffer, AAD), 'invalid-blob');
});

test('AAD binds a blob to its table, column and row id', () => {
  const box = createSecretBox(KEY);
  const blob = box.seal('pairing key', secretAad('remote_pairings', 'k_sealed', 'row-1'));
  expectBoxError(() => box.open(blob, secretAad('remote_pairings', 'k_sealed', 'row-2')), 'decrypt-failed');
  expectBoxError(
    () => box.open(blob, secretAad('remote_pairings', 'pending_destroy_sealed', 'row-1')),
    'decrypt-failed',
  );
  expectBoxError(() => box.open(blob, secretAad('other_table', 'k_sealed', 'row-1')), 'decrypt-failed');
  assert.deepEqual(box.open(blob, secretAad('remote_pairings', 'k_sealed', 'row-1')), Buffer.from('pairing key'));
});

test('secretAad has the contracted shape and rejects ambiguous components', () => {
  assert.equal(secretAad('remote_pairings', 'k_sealed', 'abc'), 'remote_pairings|k_sealed|abc|v1');
  expectBoxError(() => secretAad('a|b', 'c', 'd'), 'invalid-aad');
  expectBoxError(() => secretAad('a', 'b|c', 'd'), 'invalid-aad');
  expectBoxError(() => secretAad('a', 'b', 'c|d'), 'invalid-aad');
  expectBoxError(() => secretAad('', 'b', 'c'), 'invalid-aad');
});

test('createSecretBox needs a 32-byte key and exposes the master key id', () => {
  assert.throws(() => createSecretBox(Buffer.alloc(31)), /32 bytes/);
  const expected = crypto.createHash('sha256').update(KEY).digest().subarray(0, 8).toString('hex');
  assert.equal(computeMasterKeyId(KEY), expected);
  assert.equal(createSecretBox(KEY).keyId, expected);
  assert.match(expected, /^[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------------------
// master key resolution
// ---------------------------------------------------------------------------

test('a valid env master key is used, recorded by id, and no key file is written', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const { store, state } = createMemoryStore();
    const resolved = resolveMasterKey({
      env: { [MASTER_KEY_ENV]: KEY.toString('base64') },
      keyFilePath,
      store,
    });
    assert.deepEqual(resolved.key, KEY);
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.created, false);
    assert.equal(state.keyId, computeMasterKeyId(KEY));
    assert.equal(fs.existsSync(keyFilePath), false);
  });
});

test('an env master key with the wrong length or encoding is rejected', async () => {
  await withTempDir((dir) => {
    for (const bad of [Buffer.alloc(16).toString('base64'), Buffer.alloc(48).toString('base64'), '!!!not-base64!!!']) {
      assert.throws(
        () => resolveMasterKey({ env: { [MASTER_KEY_ENV]: bad }, keyFilePath: path.join(dir, 'k'), store: createMemoryStore().store }),
        (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_INVALID',
      );
    }
  });
});

test('no env, no sealed data, no file: a key file is generated, then reused on the next start', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'nested', 'remote-master.key');
    const { store, state } = createMemoryStore();
    const first = resolveMasterKey({ env: {}, keyFilePath, store });
    assert.equal(first.source, 'file');
    assert.equal(first.created, true);
    assert.equal(first.key.length, 32);
    assert.equal(fs.readFileSync(keyFilePath, 'utf8').trim().length, 44);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(keyFilePath).mode & 0o777, 0o600);
    }
    assert.equal(state.keyId, computeMasterKeyId(first.key));

    const second = resolveMasterKey({ env: {}, keyFilePath, store });
    assert.equal(second.created, false);
    assert.deepEqual(second.key, first.key);
  });
});

test('the env key wins over a key file', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    fs.writeFileSync(keyFilePath, OTHER_KEY.toString('base64'));
    const resolved = resolveMasterKey({
      env: { [MASTER_KEY_ENV]: KEY.toString('base64') },
      keyFilePath,
      store: createMemoryStore().store,
    });
    assert.deepEqual(resolved.key, KEY);
  });
});

test('existing sealed data with a matching master_key_id resolves normally (env or file)', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    fs.writeFileSync(keyFilePath, KEY.toString('base64'));
    const { store } = createMemoryStore({ keyId: computeMasterKeyId(KEY), sealed: true });
    assert.deepEqual(resolveMasterKey({ env: {}, keyFilePath, store }).key, KEY);
    assert.deepEqual(
      resolveMasterKey({ env: { [MASTER_KEY_ENV]: KEY.toString('base64') }, keyFilePath: path.join(dir, 'none'), store }).key,
      KEY,
    );
  });
});

test('sealed data with a different master_key_id fails closed (env changed)', async () => {
  await withTempDir((dir) => {
    const { store, state } = createMemoryStore({ keyId: computeMasterKeyId(KEY), sealed: true });
    assert.throws(
      () => resolveMasterKey({ env: { [MASTER_KEY_ENV]: OTHER_KEY.toString('base64') }, keyFilePath: path.join(dir, 'k'), store }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_MISMATCH',
    );
    assert.equal(state.keyId, computeMasterKeyId(KEY), 'the stored id must not be overwritten');
  });
});

test('sealed data with a different key file fails closed', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    fs.writeFileSync(keyFilePath, OTHER_KEY.toString('base64'));
    const { store } = createMemoryStore({ keyId: computeMasterKeyId(KEY), sealed: true });
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath, store }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_MISMATCH',
    );
  });
});

test('sealed data and a missing key file never generates a new key', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const { store } = createMemoryStore({ keyId: computeMasterKeyId(KEY), sealed: true });
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath, store }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_MISMATCH',
    );
    assert.equal(fs.existsSync(keyFilePath), false);
  });
});

test('sealed data without any recorded master_key_id cannot be verified and fails closed', async () => {
  await withTempDir((dir) => {
    assert.throws(
      () =>
        resolveMasterKey({
          env: { [MASTER_KEY_ENV]: KEY.toString('base64') },
          keyFilePath: path.join(dir, 'k'),
          store: createMemoryStore({ keyId: null, sealed: true }).store,
        }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_MISMATCH',
    );
  });
});

test('a changed key is accepted once no sealed data remains, and the id is updated', async () => {
  await withTempDir((dir) => {
    const { store, state } = createMemoryStore({ keyId: computeMasterKeyId(KEY), sealed: false });
    resolveMasterKey({ env: { [MASTER_KEY_ENV]: OTHER_KEY.toString('base64') }, keyFilePath: path.join(dir, 'k'), store });
    assert.equal(state.keyId, computeMasterKeyId(OTHER_KEY));
  });
});

test('a corrupt key file is an error, not a reason to generate a new key', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    fs.writeFileSync(keyFilePath, 'garbage');
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath, store: createMemoryStore().store }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_INVALID',
    );
    assert.equal(fs.readFileSync(keyFilePath, 'utf8'), 'garbage');
  });
});

test('unexpected file-system errors are rethrown instead of being treated as a missing file', async () => {
  await withTempDir((dir) => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const failingFs = { ...fs, readFileSync: () => { throw denied; } } as unknown as typeof fs;
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath: path.join(dir, 'k'), store: createMemoryStore().store, fs: failingFs }),
      (error: unknown) => error === denied,
    );
  });
});

test('losing the create race adopts the key the other process wrote', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    fs.writeFileSync(keyFilePath, OTHER_KEY.toString('base64'));
    let firstRead = true;
    const racingFs = {
      ...fs,
      readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
        if (firstRead) {
          firstRead = false;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return fs.readFileSync(...args);
      },
    } as unknown as typeof fs;
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: createMemoryStore().store, fs: racingFs });
    assert.deepEqual(resolved.key, OTHER_KEY);
    assert.equal(resolved.created, false);
    assert.deepEqual(fs.readdirSync(dir), ['remote-master.key']);
  });
});

test('a set-but-blank env key is a configuration error, never a silent fallback', async () => {
  await withTempDir((dir) => {
    for (const blank of ['', '   ']) {
      const keyFilePath = path.join(dir, 'remote-master.key');
      assert.throws(
        () => resolveMasterKey({ env: { [MASTER_KEY_ENV]: blank }, keyFilePath, store: createMemoryStore().store }),
        (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_INVALID',
      );
      assert.equal(fs.existsSync(keyFilePath), false);
    }
  });
});

test('scrubEnv removes the env key after reading it; default leaves the environment alone', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'k');
    const kept: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: KEY.toString('base64'), OTHER: 'x' };
    resolveMasterKey({ env: kept, keyFilePath, store: createMemoryStore().store });
    assert.equal(kept[MASTER_KEY_ENV], KEY.toString('base64'));

    const scrubbed: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: KEY.toString('base64'), OTHER: 'x' };
    const resolved = resolveMasterKey({ env: scrubbed, keyFilePath, store: createMemoryStore().store, scrubEnv: true });
    assert.deepEqual(resolved.key, KEY);
    assert.equal(scrubbed[MASTER_KEY_ENV], undefined);
    assert.equal(scrubbed.OTHER, 'x');
  });
});

test('sealed data with no recorded key id is reported as such and nothing is written or created', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const { store, state } = createMemoryStore({ keyId: null, sealed: true });
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath, store }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_MISMATCH' && /no master key is available/.test(error.message),
    );
    assert.equal(fs.existsSync(keyFilePath), false);
    fs.writeFileSync(keyFilePath, KEY.toString('base64'));
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath, store }),
      (error: unknown) => error instanceof SecretBoxError && error.code === 'MASTER_KEY_MISMATCH' && /never recorded/.test(error.message),
    );
    assert.deepEqual(state.writes, []);
  });
});

test('key file creation leaves no temp file and never exposes a partial key', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const seenSizes: number[] = [];
    const watchingFs = {
      ...fs,
      linkSync: (existing: fs.PathLike, target: fs.PathLike) => {
        seenSizes.push(fs.statSync(existing).size); // the temp file is complete before it is linked
        return fs.linkSync(existing, target);
      },
    } as unknown as typeof fs;
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: createMemoryStore().store, fs: watchingFs });
    assert.deepEqual(seenSizes, [45]);
    assert.deepEqual(fs.readdirSync(dir), ['remote-master.key']);
    assert.deepEqual(Buffer.from(fs.readFileSync(keyFilePath, 'utf8').trim(), 'base64'), resolved.key);
  });
});

test('a file system without hard links falls back to an exclusive direct write', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const noLinkFs = {
      ...fs,
      linkSync: () => { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }); },
    } as unknown as typeof fs;
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: createMemoryStore().store, fs: noLinkFs });
    assert.equal(resolved.created, true);
    assert.deepEqual(Buffer.from(fs.readFileSync(keyFilePath, 'utf8').trim(), 'base64'), resolved.key);
    assert.deepEqual(fs.readdirSync(dir), ['remote-master.key']);
  });
});

test('other link failures are rethrown and leave nothing behind', async () => {
  await withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const brokenFs = {
      ...fs,
      linkSync: () => { throw Object.assign(new Error('disk on fire'), { code: 'EIO' }); },
    } as unknown as typeof fs;
    assert.throws(
      () => resolveMasterKey({ env: {}, keyFilePath, store: createMemoryStore().store, fs: brokenFs }),
      /disk on fire/,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('errors from the store propagate instead of being swallowed', async () => {
  await withTempDir((dir) => {
    const boom = new Error('db unavailable');
    const store: MasterKeyStore = {
      readKeyId: () => { throw boom; },
      writeKeyId: () => undefined,
      hasSealedData: () => false,
    };
    assert.throws(
      () => resolveMasterKey({ env: { [MASTER_KEY_ENV]: KEY.toString('base64') }, keyFilePath: path.join(dir, 'k'), store }),
      (error: unknown) => error === boom,
    );
  });
});

// ---------------------------------------------------------------------------
// strict app_config store
// ---------------------------------------------------------------------------

const createDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};

const createPairingsTable = (db: InstanceType<typeof Database>) =>
  db.exec('CREATE TABLE remote_pairings (id TEXT PRIMARY KEY, k_sealed BLOB, pending_destroy_sealed BLOB)');

test('the strict store reads and upserts remote.master_key_id', () => {
  const db = createDb();
  const store = createAppConfigMasterKeyStore(() => db);
  assert.equal(store.readKeyId(), null);
  store.writeKeyId('aaaa');
  store.writeKeyId('bbbb');
  assert.equal(store.readKeyId(), 'bbbb');
  assert.equal(
    (db.prepare("SELECT value FROM app_config WHERE key = 'remote.master_key_id'").get() as { value: string }).value,
    'bbbb',
  );
});

test('hasSealedData sees the sealed relay secret', () => {
  const db = createDb();
  const store = createAppConfigMasterKeyStore(() => db);
  assert.equal(store.hasSealedData(), false);
  db.prepare("INSERT INTO app_config (key, value) VALUES ('remote.relay_secret_sealed', 'AAAA')").run();
  assert.equal(store.hasSealedData(), true);
});

test('hasSealedData sees live pairing keys and pending destroys but not revoked rows', () => {
  const db = createDb();
  createPairingsTable(db);
  const store = createAppConfigMasterKeyStore(() => db);
  db.prepare("INSERT INTO remote_pairings (id, k_sealed, pending_destroy_sealed) VALUES ('revoked', NULL, NULL)").run();
  assert.equal(store.hasSealedData(), false);
  db.prepare("INSERT INTO remote_pairings (id, k_sealed) VALUES ('live', x'0102')").run();
  assert.equal(store.hasSealedData(), true);
  db.prepare("DELETE FROM remote_pairings WHERE id = 'live'").run();
  db.prepare("INSERT INTO remote_pairings (id, pending_destroy_sealed) VALUES ('destroying', x'0304')").run();
  assert.equal(store.hasSealedData(), true);
});

test('database failures surface as errors (unlike appConfigDb.get)', () => {
  const boom = new Error('database is locked');
  const brokenDb = { prepare: () => { throw boom; } };
  const store = createAppConfigMasterKeyStore(() => brokenDb as never);
  assert.throws(() => store.readKeyId(), (error: unknown) => error === boom);
  assert.throws(() => store.writeKeyId('x'), (error: unknown) => error === boom);
  assert.throws(() => store.hasSealedData(), (error: unknown) => error === boom);
});
