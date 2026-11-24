import assert from 'node:assert/strict';
import test from 'node:test';

import { Database } from '../../database/index.js';
import { createSessionStore, migrateAuthSessions, SESSION_IDLE_LOCK_MS, SESSION_MAX_AGE_MS } from '../services/session-store.service.js';
import { createSessionConnections } from '../services/session-runtime.service.js';

function fixture(t: { after(callback: () => void): void }, enabled = true) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1); CREATE TABLE app_config(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE auth_totp(user_id INTEGER PRIMARY KEY, enabled INTEGER);');
  db.prepare('INSERT INTO auth_totp VALUES(1, ?)').run(enabled ? 1 : 0);
  let at = 1_000_000;
  migrateAuthSessions(db, at);
  const store = createSessionStore(db, () => at);
  return { db, store, now: () => at, advance: (ms: number) => { at += ms; } };
}

test('L-01/L-03/L-04: manual lock closes all transports of A while device B stays active', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  const b = f.store.create(1, '', f.now());
  const connections = createSessionConnections(f.store);
  t.after(() => connections.dispose());
  const closed: string[] = [];
  connections.track(a.session.id, () => closed.push('a-chat'));
  connections.track(a.session.id, () => closed.push('a-shell'));
  connections.track(b.session.id, () => closed.push('b-chat'));
  assert.equal(f.store.lock(a.session.id), true);
  assert.deepEqual(closed, ['a-chat', 'a-shell']);
  assert.equal(f.store.authenticate(a.secret), null);
  assert.equal(f.store.authenticate(a.secret, true)?.lockedAt, f.now());
  assert.ok(f.store.authenticate(b.secret));
});

test('L-01/L-07/L-12: idle lock is enabled by default and transport reads do not renew it', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  assert.equal(f.store.autoLockEnabled(1), true);
  f.advance(SESSION_IDLE_LOCK_MS - 1);
  assert.ok(f.store.getActive(a.session.id));
  f.advance(1);
  f.store.expire();
  assert.equal(f.store.getActive(a.session.id), null);
  assert.equal(f.store.getCurrent(a.session.id)?.lockedAt, f.now());
});

test('L-06: HTTP activity uses the latest RAM timestamp with writes no more often than five minutes', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  f.advance(SESSION_IDLE_LOCK_MS - 60_000);
  f.store.touch(a.session.id);
  const persisted = f.store.getCurrent(a.session.id)!.lastSeenAt;
  f.advance(60_000);
  f.store.touch(a.session.id);
  assert.equal(f.store.getCurrent(a.session.id)?.lastSeenAt, persisted);
  f.advance(SESSION_IDLE_LOCK_MS - 1);
  assert.ok(f.store.getActive(a.session.id), 'RAM activity prevents an early idle lock');
  f.advance(1);
  assert.equal(f.store.getActive(a.session.id), null);
});

test('L-09/L-11: without TOTP neither explicit nor automatic locking applies', t => {
  const f = fixture(t, false);
  const a = f.store.create(1);
  assert.equal(f.store.lock(a.session.id), false);
  f.advance(SESSION_IDLE_LOCK_MS);
  f.store.expire();
  assert.ok(f.store.authenticate(a.secret));
});

test('L-08/L-12: disabling auto-lock persists but does not remove explicit locking', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  f.store.setAutoLock(1, false);
  f.advance(SESSION_IDLE_LOCK_MS);
  const restarted = createSessionStore(f.db, f.now);
  assert.equal(restarted.autoLockEnabled(1), false);
  assert.ok(restarted.authenticate(a.secret));
  assert.equal(restarted.lock(a.session.id), true);
});

test('L-01/K-10: unlocking refreshes activity but never extends the seven-day deadline', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  f.advance(SESSION_IDLE_LOCK_MS);
  f.store.expire();
  assert.equal(f.store.unlock(a.session.id, 2, f.now()), false);
  assert.equal(f.store.unlock(a.session.id, 1, f.now()), true);
  assert.equal(f.store.getActive(a.session.id)?.expiresAt, a.session.expiresAt);
  assert.equal(f.store.getActive(a.session.id)?.lastSeenAt, f.now());
  f.advance(SESSION_MAX_AGE_MS);
  assert.equal(f.store.unlock(a.session.id, 1, f.now()), false);
  assert.equal(f.store.authenticate(a.secret, true), null);
});


test('L-04: idle sweep closes each transport once with a lock reason, including late connections', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  const connections = createSessionConnections(f.store);
  t.after(() => connections.dispose());
  const reasons: string[] = [];
  connections.track(a.session.id, reason => reasons.push(reason));
  f.advance(SESSION_IDLE_LOCK_MS);
  connections.sweep();
  connections.sweep();
  assert.deepEqual(reasons, ['locked']);
  connections.track(a.session.id, reason => reasons.push(reason));
  assert.deepEqual(reasons, ['locked', 'locked']);
});


for (const hours of [1, 24, 48]) {
  test(`R7-02: ${hours}-hour server policy applies to all account sessions and survives restart`, t => {
    const f = fixture(t);
    f.store.setIdleLockHours(1, hours);
    const a = f.store.create(1, '', f.now());
    const b = f.store.create(1, '', f.now());
    const restarted = createSessionStore(f.db, f.now);
    assert.equal(restarted.idleLockHours(1), hours);
    f.advance(hours * 60 * 60 * 1000 - 1);
    assert.ok(restarted.authenticate(a.secret));
    assert.ok(restarted.authenticate(b.secret));
    f.advance(1);
    restarted.expire();
    assert.equal(restarted.getCurrent(a.session.id)?.lockedAt, f.now());
    assert.equal(restarted.getCurrent(b.session.id)?.lockedAt, f.now());
  });
}

test('R7-02: additive idle policy migration defaults legacy accounts to 24 without changing sessions or epoch', t => {
  const f = fixture(t);
  const a = f.store.create(1, '', f.now());
  f.store.setAutoLock(1, false);
  f.db.exec("DROP TABLE auth_session_idle_policy; DELETE FROM schema_migrations WHERE id='auth-session-idle-policy-v1'");
  const epoch = f.db.prepare("SELECT value FROM app_config WHERE key='auth.token_epoch'").get();
  migrateAuthSessions(f.db, f.now());
  migrateAuthSessions(f.db, f.now());
  assert.equal(f.store.idleLockHours(1), 24);
  assert.equal(f.store.autoLockEnabled(1), false);
  assert.deepEqual(f.store.authenticate(a.secret), a.session);
  assert.deepEqual(f.db.prepare("SELECT value FROM app_config WHERE key='auth.token_epoch'").get(), epoch);
  f.store.setIdleLockHours(1, 168);
  migrateAuthSessions(f.db, f.now());
  assert.equal(createSessionStore(f.db).idleLockHours(1), 168);
  assert.equal(f.db.prepare("PRAGMA integrity_check").get()?.integrity_check, 'ok');
});

test('R7-02: policy is scoped to one account, shortening locks idle sessions, disabled auto-lock stays disabled', t => {
  const f = fixture(t);
  f.db.exec('INSERT INTO users VALUES(2); INSERT INTO auth_totp VALUES(2,1)');
  const a = f.store.create(1, '', f.now());
  const b = f.store.create(2, '', f.now());
  f.advance(2 * 60 * 60 * 1000);
  f.store.setIdleLockHours(1, 1);
  f.store.expire();
  assert.equal(f.store.getActive(a.session.id), null);
  assert.ok(f.store.getActive(b.session.id));
  f.store.setAutoLock(1, false);
  const c = f.store.create(1, '', f.now());
  f.advance(60 * 60 * 1000);
  assert.ok(f.store.getActive(c.session.id));
});
