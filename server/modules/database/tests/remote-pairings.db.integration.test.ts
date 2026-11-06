import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RemotePairingRow } from '@/shared/types.js';
import {
  appConfigDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  remoteConfigDb,
  remotePairingsDb,
} from '@/modules/database/index.js';

async function withDatabase(runTest: (databasePath: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'remote-pairings-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  try {
    await runTest(databasePath);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const row = (overrides: Partial<RemotePairingRow> = {}): RemotePairingRow => ({
  id: 'pairing-1',
  role: 'host',
  peer_name: 'My Laptop',
  alias: null,
  k_sealed: Buffer.from([1, 2, 3]),
  pending_destroy_sealed: null,
  room_id: 'a'.repeat(32),
  relay_url: 'wss://relay.example',
  created_at: 1000,
  last_connected_at: null,
  last_activity_at: null,
  revoked_at: null,
  expires_at: null,
  ...overrides,
});

test('initializing the database twice is safe and creates the pairing table with the contract columns', async () => {
  await withDatabase(async () => {
    await initializeDatabase();
    await initializeDatabase();
    const columns = (getConnection().prepare('PRAGMA table_info(remote_pairings)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    assert.deepEqual(columns, [
      'id',
      'role',
      'peer_name',
      'alias',
      'k_sealed',
      'pending_destroy_sealed',
      'room_id',
      'relay_url',
      'created_at',
      'last_connected_at',
      'last_activity_at',
      'revoked_at',
      'expires_at',
    ]);
  });
});

test('an alias is stored next to the declared name, can be changed and cleared, and a missing row reports false', async () => {
  await withDatabase(() => {
    remotePairingsDb.insert(row({ id: 'a', peer_name: 'DESKTOP-9F3K2L' }));

    assert.equal(remotePairingsDb.getById('a')?.alias, null);
    assert.equal(remotePairingsDb.setAlias('a', 'Home PC'), true);
    assert.equal(remotePairingsDb.getById('a')?.alias, 'Home PC');
    assert.equal(remotePairingsDb.getById('a')?.peer_name, 'DESKTOP-9F3K2L', 'the declared name is kept');

    assert.equal(remotePairingsDb.setAlias('a', null), true);
    assert.equal(remotePairingsDb.getById('a')?.alias, null);
    assert.equal(remotePairingsDb.setAlias('missing', 'x'), false);
  });
});

test('a database from before the alias existed gets the column on upgrade and keeps its rows', async () => {
  await withDatabase(async () => {
    const db = getConnection();
    // The table as older versions created it: no `alias`.
    db.exec('DROP TABLE remote_pairings');
    db.exec(`CREATE TABLE remote_pairings (
      id TEXT PRIMARY KEY NOT NULL, role TEXT NOT NULL CHECK (role IN ('host', 'controller')), peer_name TEXT NOT NULL,
      k_sealed BLOB, pending_destroy_sealed BLOB, room_id TEXT NOT NULL, relay_url TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_connected_at INTEGER, last_activity_at INTEGER, revoked_at INTEGER, expires_at INTEGER
    )`);
    db.prepare("INSERT INTO remote_pairings (id, role, peer_name, room_id, relay_url, created_at) VALUES ('old', 'controller', 'Office PC', 'r', 'wss://relay.example', 1)").run();

    const { runMigrations } = await import('@/modules/database/migrations.js');
    runMigrations(db);
    runMigrations(db); // running it again must not fail

    const columns = (db.prepare('PRAGMA table_info(remote_pairings)').all() as Array<{ name: string }>).map((column) => column.name);
    assert.ok(columns.includes('alias'));
    assert.equal(remotePairingsDb.getById('old')?.peer_name, 'Office PC');
    assert.equal(remotePairingsDb.getById('old')?.alias, null, 'existing pairings show their declared name until renamed');
    assert.equal(remotePairingsDb.setAlias('old', 'Office'), true);
  });
});

test('rows survive a second initialization untouched', async () => {
  await withDatabase(async () => {
    remotePairingsDb.insert(row());
    await initializeDatabase();
    assert.equal(remotePairingsDb.getById('pairing-1')?.peer_name, 'My Laptop');
  });
});

test('insert and read back every column, including the sealed blobs as Buffers', async () => {
  await withDatabase(() => {
    remotePairingsDb.insert(row({ pending_destroy_sealed: Buffer.from([9, 9]), expires_at: 5000, last_connected_at: 1500, last_activity_at: 1600 }));
    const stored = remotePairingsDb.getById('pairing-1');
    assert.ok(stored);
    assert.ok(Buffer.isBuffer(stored.k_sealed));
    assert.deepEqual([...(stored.k_sealed as Buffer)], [1, 2, 3]);
    assert.deepEqual([...(stored.pending_destroy_sealed as Buffer)], [9, 9]);
    assert.equal(stored.expires_at, 5000);
    assert.equal(stored.last_connected_at, 1500);
    assert.equal(remotePairingsDb.getById('missing'), null);
  });
});

test('the role column only accepts host or controller, and ids are unique', async () => {
  await withDatabase(() => {
    assert.throws(() => remotePairingsDb.insert(row({ role: 'admin' as 'host' })));
    remotePairingsDb.insert(row());
    assert.throws(() => remotePairingsDb.insert(row()));
  });
});

test('list is newest first and can be limited to a role; countActive ignores revoked rows', async () => {
  await withDatabase(() => {
    remotePairingsDb.insert(row({ id: 'a', created_at: 1 }));
    remotePairingsDb.insert(row({ id: 'b', created_at: 3 }));
    remotePairingsDb.insert(row({ id: 'c', created_at: 2, role: 'controller' }));
    remotePairingsDb.insert(row({ id: 'd', created_at: 4 }));
    assert.deepEqual(remotePairingsDb.list().map((r) => r.id), ['d', 'b', 'c', 'a']);
    assert.deepEqual(remotePairingsDb.list('host').map((r) => r.id), ['d', 'b', 'a']);
    assert.equal(remotePairingsDb.countActive('host'), 3);
    assert.equal(remotePairingsDb.countActive('controller'), 1);

    assert.equal(remotePairingsDb.revoke('b', 10, Buffer.from([7])), true);
    assert.equal(remotePairingsDb.countActive('host'), 2);
    assert.equal(remotePairingsDb.list('host').length, 3, 'revoked rows stay listed');
  });
});

test('revoke sets revoked_at, erases k_sealed, stores the pending destroy once, and clearing it works', async () => {
  await withDatabase(() => {
    remotePairingsDb.insert(row());
    assert.equal(remotePairingsDb.revoke('pairing-1', 2000, Buffer.from([5, 5, 5])), true);
    const revoked = remotePairingsDb.getById('pairing-1');
    assert.ok(revoked);
    assert.equal(revoked.revoked_at, 2000);
    assert.equal(revoked.k_sealed, null);
    assert.deepEqual([...(revoked.pending_destroy_sealed as Buffer)], [5, 5, 5]);
    assert.deepEqual(remotePairingsDb.listPendingDestroy().map((r) => r.id), ['pairing-1']);

    assert.equal(remotePairingsDb.revoke('pairing-1', 3000, Buffer.from([6])), false, 'a second revoke changes nothing');
    assert.equal(remotePairingsDb.getById('pairing-1')?.revoked_at, 2000);
    assert.equal(remotePairingsDb.revoke('missing', 1, null), false);

    remotePairingsDb.clearPendingDestroy('pairing-1');
    assert.equal(remotePairingsDb.getById('pairing-1')?.pending_destroy_sealed, null);
    assert.deepEqual(remotePairingsDb.listPendingDestroy(), []);
  });
});

test('connection and activity timestamps update independently', async () => {
  await withDatabase(() => {
    remotePairingsDb.insert(row());
    remotePairingsDb.touchActivity('pairing-1', 100);
    assert.deepEqual(
      [remotePairingsDb.getById('pairing-1')?.last_connected_at, remotePairingsDb.getById('pairing-1')?.last_activity_at],
      [null, 100],
    );
    remotePairingsDb.markConnected('pairing-1', 200);
    assert.deepEqual(
      [remotePairingsDb.getById('pairing-1')?.last_connected_at, remotePairingsDb.getById('pairing-1')?.last_activity_at],
      [200, 200],
    );
  });
});

test('delete removes only the named row', async () => {
  await withDatabase(() => {
    remotePairingsDb.insert(row({ id: 'a' }));
    remotePairingsDb.insert(row({ id: 'b' }));
    remotePairingsDb.delete('a');
    assert.deepEqual(remotePairingsDb.list().map((r) => r.id), ['b']);
  });
});

test('the throwing remote config repository reads, writes and deletes only remote.* keys', async () => {
  await withDatabase(() => {
    assert.equal(remoteConfigDb.get('remote.relay_url'), null);
    remoteConfigDb.set('remote.relay_url', 'wss://relay.example');
    assert.equal(remoteConfigDb.get('remote.relay_url'), 'wss://relay.example');
    remoteConfigDb.set('remote.relay_url', 'wss://other.example');
    assert.equal(remoteConfigDb.get('remote.relay_url'), 'wss://other.example');
    remoteConfigDb.delete('remote.relay_url');
    assert.equal(remoteConfigDb.get('remote.relay_url'), null);

    for (const key of ['jwt_secret', 'remote', 'auth.token_epoch', '']) {
      assert.throws(() => remoteConfigDb.get(key), /remote\./, key);
      assert.throws(() => remoteConfigDb.set(key, 'x'), /remote\./, key);
    }
  });
});

test('unlike appConfigDb.get, the remote config repository does not swallow database errors', async () => {
  await withDatabase(() => {
    remoteConfigDb.set('remote.relay_url', 'wss://relay.example');
    getConnection().exec('DROP TABLE app_config');
    assert.equal(appConfigDb.get('remote.relay_url'), null, 'the generic reader hides the failure');
    assert.throws(() => remoteConfigDb.get('remote.relay_url'), /no such table/);
    assert.throws(() => remoteConfigDb.set('remote.relay_url', 'x'), /no such table/);
  });
});

test('test databases live in the temp directory, never in the source tree', async () => {
  await withDatabase((databasePath) => {
    assert.ok(databasePath.startsWith(os.tmpdir()));
  });
});
