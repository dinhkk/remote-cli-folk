import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { getConnection } from '@/modules/database/index.js';
import type { RemotePairingRow } from '@/shared/types.js';

import { deriveLinkKeys } from '../../crypto/key-derivation.js';
import { SecretBoxError, createSecretBox, secretAad } from '../../crypto/secret-box.js';
import { createPairingStore } from '../../pairing/pairing-store.service.js';
import { withTempDatabase } from '../support/temp-database.js';

const MASTER = Buffer.alloc(32, 0x11);
const rawRows = (): RemotePairingRow[] => getConnection().prepare('SELECT * FROM remote_pairings').all() as RemotePairingRow[];
const newStore = (now = () => 1_000) => createPairingStore({ box: createSecretBox(MASTER), now });

const expectBoxError = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof SecretBoxError && error.code === code);

test('a stored pairing round-trips: K opens, the record has no secrets', async () => {
  await withTempDatabase(() => {
    const store = newStore();
    const k = crypto.randomBytes(32);
    const record = store.insertPairing({ role: 'host', peerName: 'My Laptop', k, relayUrl: 'wss://relay.example' });

    assert.equal(record.role, 'host');
    assert.equal(record.peerName, 'My Laptop');
    assert.equal(record.relayUrl, 'wss://relay.example');
    assert.equal(record.roomId, deriveLinkKeys(k).roomId);
    assert.equal(record.createdAt, 1_000);
    assert.deepEqual([record.revokedAt, record.expiresAt, record.lastConnectedAt, record.pendingDestroy], [null, null, null, false]);
    assert.ok(store.openPairingKey(record.id).equals(k));
    assert.deepEqual(store.getPairing(record.id), record);
    assert.equal(store.getPairing('missing'), null);
    assert.ok(!JSON.stringify(record).includes(k.toString('hex')));
  });
});

test('the database holds no plaintext K in any column or in the file itself (AC-28)', async () => {
  await withTempDatabase((databasePath) => {
    const store = newStore();
    const k = crypto.randomBytes(32);
    const { hostToken, controllerToken, macKey } = deriveLinkKeys(k);
    store.insertPairing({ role: 'host', peerName: 'My Laptop', k, relayUrl: 'wss://relay.example' });
    const revoked = store.insertPairing({ role: 'host', peerName: 'Other', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    store.revokeHostPairing(revoked.id);

    const forms = (secret: Buffer): Array<string | Buffer> => [secret, secret.toString('hex'), secret.toString('base64'), secret.toString('base64url')];
    const dump = JSON.stringify(rawRows().map((r) => ({ ...r, k_sealed: r.k_sealed?.toString('latin1'), pending_destroy_sealed: r.pending_destroy_sealed?.toString('latin1') })));
    const fileBytes = [databasePath, `${databasePath}-wal`].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p));
    for (const secret of [k, macKey, Buffer.from(hostToken), Buffer.from(controllerToken)]) {
      for (const form of forms(secret)) {
        assert.ok(!dump.includes(form.toString('latin1')), 'a table column contains key material');
        for (const bytes of fileBytes) assert.equal(bytes.indexOf(form), -1, 'the database file contains key material');
      }
    }
  });
});

test('the sealed blob is bound to its row: swapping k_sealed between two rows breaks opening', async () => {
  await withTempDatabase(() => {
    const store = newStore();
    const a = store.insertPairing({ role: 'host', peerName: 'A', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    const b = store.insertPairing({ role: 'host', peerName: 'B', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    const db = getConnection();
    const sealedA = (db.prepare('SELECT k_sealed FROM remote_pairings WHERE id = ?').get(a.id) as { k_sealed: Buffer }).k_sealed;
    const sealedB = (db.prepare('SELECT k_sealed FROM remote_pairings WHERE id = ?').get(b.id) as { k_sealed: Buffer }).k_sealed;
    db.prepare('UPDATE remote_pairings SET k_sealed = ? WHERE id = ?').run(sealedB, a.id);
    db.prepare('UPDATE remote_pairings SET k_sealed = ? WHERE id = ?').run(sealedA, b.id);

    expectBoxError(() => store.openPairingKey(a.id), 'decrypt-failed');
    expectBoxError(() => store.openPairingKey(b.id), 'decrypt-failed');
  });
});

test('a different master key cannot open K, and opening an unknown pairing throws', async () => {
  await withTempDatabase(() => {
    const store = newStore();
    const record = store.insertPairing({ role: 'controller', peerName: 'Host', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    const other = createPairingStore({ box: createSecretBox(Buffer.alloc(32, 0x22)), now: () => 1 });
    expectBoxError(() => other.openPairingKey(record.id), 'decrypt-failed');
    assert.throws(() => store.openPairingKey('missing'), /unknown pairing/i);
  });
});

test('insert validates K and the role/relay inputs', async () => {
  await withTempDatabase(() => {
    const store = newStore();
    assert.throws(() => store.insertPairing({ role: 'host', peerName: 'x', k: Buffer.alloc(31), relayUrl: 'wss://relay.example' }), /32 bytes/);
    assert.throws(() => store.insertPairing({ id: 'a|b', role: 'host', peerName: 'x', k: Buffer.alloc(32, 1), relayUrl: 'wss://relay.example' }));
    assert.equal(rawRows().length, 0, 'a rejected insert leaves nothing behind');
    const a = store.insertPairing({ role: 'host', peerName: 'x', k: Buffer.alloc(32, 1), relayUrl: 'wss://relay.example' });
    const b = store.insertPairing({ role: 'host', peerName: 'x', k: Buffer.alloc(32, 1), relayUrl: 'wss://relay.example' });
    assert.notEqual(a.id, b.id, 'ids are generated');
    const custom = store.insertPairing({ id: 'custom-id', role: 'host', peerName: 'x', k: Buffer.alloc(32, 2), relayUrl: 'wss://relay.example', expiresAt: 9_999 });
    assert.equal(custom.id, 'custom-id');
    assert.equal(custom.expiresAt, 9_999);
  });
});

test('revoking a Host pairing erases K, keeps only roomId + hostToken sealed for the relay DESTROY retry', async () => {
  await withTempDatabase(() => {
    let now = 1_000;
    const store = newStore(() => now);
    const k = crypto.randomBytes(32);
    const record = store.insertPairing({ role: 'host', peerName: 'My Laptop', k, relayUrl: 'wss://relay.example' });
    const keys = deriveLinkKeys(k);

    now = 2_000;
    const revoked = store.revokeHostPairing(record.id);
    assert.equal(revoked.revokedAt, 2_000);
    assert.equal(revoked.pendingDestroy, true);

    const stored = rawRows()[0];
    assert.equal(stored.k_sealed, null);
    assert.ok(stored.pending_destroy_sealed);
    const plaintext = JSON.parse(
      createSecretBox(MASTER).open(stored.pending_destroy_sealed, secretAad('remote_pairings', 'pending_destroy_sealed', record.id)).toString('utf8'),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(plaintext).sort(), ['hostToken', 'roomId']);
    assert.deepEqual(store.listPendingDestroy(), [{ id: record.id, roomId: keys.roomId, hostToken: keys.hostToken }]);

    assert.throws(() => store.openPairingKey(record.id), /revoked/i);
    assert.throws(() => store.revokeHostPairing(record.id), /already revoked|unknown/i);
    assert.equal(store.countActivePairings('host'), 0);

    store.clearPendingDestroy(record.id);
    assert.deepEqual(store.listPendingDestroy(), []);
    assert.equal(store.getPairing(record.id)?.pendingDestroy, false);
    assert.equal(store.getPairing(record.id)?.revokedAt, 2_000, 'the revocation itself is permanent');
  });
});

test('only Host pairings can be revoked; a Controller forgets by deleting', async () => {
  await withTempDatabase(() => {
    const store = newStore();
    const record = store.insertPairing({ role: 'controller', peerName: 'Host', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    assert.throws(() => store.revokeHostPairing(record.id), /host/i);
    assert.throws(() => store.revokeHostPairing('missing'), /unknown/i);
    store.deletePairing(record.id);
    assert.equal(store.getPairing(record.id), null);
    store.deletePairing(record.id); // idempotent
  });
});

test('listing, counting and timestamps', async () => {
  await withTempDatabase(() => {
    let now = 100;
    const store = newStore(() => now);
    const host = store.insertPairing({ role: 'host', peerName: 'A', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    now = 200;
    const controller = store.insertPairing({ role: 'controller', peerName: 'B', k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' });
    assert.deepEqual(store.listPairings().map((r) => r.id), [controller.id, host.id]);
    assert.deepEqual(store.listPairings('host').map((r) => r.id), [host.id]);
    assert.equal(store.countActivePairings('host'), 1);
    assert.equal(store.countActivePairings('controller'), 1);

    now = 300;
    store.touchActivity(host.id);
    assert.deepEqual([store.getPairing(host.id)?.lastConnectedAt, store.getPairing(host.id)?.lastActivityAt], [null, 300]);
    now = 400;
    store.markConnected(host.id);
    assert.deepEqual([store.getPairing(host.id)?.lastConnectedAt, store.getPairing(host.id)?.lastActivityAt], [400, 400]);
  });
});

test('one unreadable pending-destroy row is skipped and reported by id; the other retries still come back', async () => {
  await withTempDatabase(() => {
    const skipped: string[] = [];
    const store = createPairingStore({ box: createSecretBox(MASTER), now: () => 1_000, onSkippedPendingDestroy: (id) => skipped.push(id) });
    const records = ['A', 'B', 'C', 'D'].map((peerName) => store.insertPairing({ role: 'host', peerName, k: crypto.randomBytes(32), relayUrl: 'wss://relay.example' }));
    for (const record of records) store.revokeHostPairing(record.id);

    const db = getConnection();
    // B: a blob sealed for another row (fails to open); C: opens but is not the expected JSON.
    const sealedOf = (id: string) => (db.prepare('SELECT pending_destroy_sealed AS blob FROM remote_pairings WHERE id = ?').get(id) as { blob: Buffer }).blob;
    db.prepare('UPDATE remote_pairings SET pending_destroy_sealed = ? WHERE id = ?').run(sealedOf(records[0].id), records[1].id);
    const notJson = createSecretBox(MASTER).seal('not json {', secretAad('remote_pairings', 'pending_destroy_sealed', records[2].id));
    db.prepare('UPDATE remote_pairings SET pending_destroy_sealed = ? WHERE id = ?').run(notJson, records[2].id);

    const pending = store.listPendingDestroy();
    assert.deepEqual(pending.map((entry) => entry.id), [records[0].id, records[3].id]);
    assert.deepEqual(skipped, [records[1].id, records[2].id], 'ids are reported, never contents');
    // Without a reporter a corrupt row is still skipped silently.
    assert.equal(newStore().listPendingDestroy().length, 2);
  });
});
