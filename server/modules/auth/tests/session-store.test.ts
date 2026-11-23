import assert from 'node:assert/strict';
import test from 'node:test';

import { Database } from '../../database/index.js';
import { createSessionStore, migrateAuthSessions, SESSION_MAX_AGE_MS } from '../services/session-store.service.js';

function fixture(t: { after(callback: () => void): void }) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users VALUES (1, 'owner'), (2, 'other');
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO app_config VALUES ('auth.token_epoch', '3'), ('jwt_secret', 'synthetic-pinned-secret');`);
  let current = 1_000_000;
  migrateAuthSessions(db, current);
  const store = createSessionStore(db, () => current);
  return { db, store, advance: (ms: number) => { current += ms; } };
}

test('A-03/C-08: each login has fresh credentials; database and device list never expose the cookie secret', (t) => {
  const { db, store } = fixture(t);
  const a = store.create(1);
  const b = store.create(1);
  assert.notEqual(a.secret, b.secret);
  assert.notEqual(a.session.id, b.session.id);
  assert.equal(store.authenticate(a.secret)?.id, a.session.id);
  assert.equal(store.authenticate(a.session.id), null);
  const stored = JSON.stringify(db.prepare('SELECT * FROM auth_sessions').all());
  assert.ok(!stored.includes(a.secret));
  assert.ok(!JSON.stringify(store.list(1)).includes(a.secret));
  assert.equal(store.authenticate('x'.repeat(43)), null);
});

test('K-11/L-04: revoke A notifies every listener, preserves B, and checks ownership', (t) => {
  const { store } = fixture(t);
  const a = store.create(1);
  const b = store.create(1);
  const closed: string[] = [];
  store.onEnd(() => { throw new Error('synthetic transport close failure'); });
  store.onEnd(({ sessionId }) => closed.push(sessionId));
  assert.equal(store.revoke(a.session.id, 2), false);
  assert.equal(store.revoke(a.session.id, 1), true);
  assert.deepEqual(closed, [a.session.id]);
  assert.equal(store.authenticate(a.secret), null);
  assert.equal(store.authenticate(b.secret)?.id, b.session.id);
  assert.equal(store.revoke(a.session.id, 1), false);
});

test('K-11: logout-all revokes persistent sessions without rotating a pinned signing secret', (t) => {
  const { db, store } = fixture(t);
  const a = store.create(1);
  const b = store.create(1);
  const other = store.create(2);
  assert.equal(store.revokeAll(1), 2);
  const restarted = createSessionStore(db, () => a.session.createdAt + 1000);
  assert.equal(restarted.authenticate(a.secret), null);
  assert.equal(restarted.authenticate(b.secret), null);
  assert.equal(store.authenticate(other.secret)?.userId, 2);
  assert.equal(db.prepare<{ value: string }>("SELECT value FROM app_config WHERE key='jwt_secret'").get()?.value, 'synthetic-pinned-secret');
});

test('K-10/L-04: absolute seven-day expiry is not extended by HTTP activity and is swept without a request', (t) => {
  const { store, advance } = fixture(t);
  const a = store.create(1);
  const ended: string[] = [];
  store.onEnd(({ reason }) => ended.push(reason));
  advance(SESSION_MAX_AGE_MS - 1);
  assert.ok(store.touch(a.session.id));
  assert.ok(store.authenticate(a.secret));
  advance(1);
  assert.equal(store.expire(), 1);
  assert.equal(store.expire(), 0);
  assert.equal(store.authenticate(a.secret), null);
  assert.deepEqual(ended, ['expired']);
});

test('L-06: HTTP activity is accurate in memory with bounded database writes', (t) => {
  const { store, db, advance } = fixture(t);
  const a = store.create(1);
  advance(1000);
  store.touch(a.session.id);
  assert.equal(store.lastActivity(a.session.id), a.session.createdAt + 1000);
  assert.equal(db.prepare<{ last_seen_at: number }>('SELECT last_seen_at FROM auth_sessions').get()?.last_seen_at, a.session.createdAt);
  advance(5 * 60 * 1000);
  store.touch(a.session.id);
  assert.equal(db.prepare<{ last_seen_at: number }>('SELECT last_seen_at FROM auth_sessions').get()?.last_seen_at, a.session.createdAt + 301000);
});

test('G-03: a persisted locked session is not authenticated', (t) => {
  const { store, db } = fixture(t);
  const a = store.create(1);
  db.prepare('UPDATE auth_sessions SET locked_at = ? WHERE id = ?').run(1, a.session.id);
  assert.equal(store.authenticate(a.secret), null);
});

test('K-20: additive migration increments legacy epoch only once and preserves existing data', (t) => {
  const { store, db } = fixture(t);
  const a = store.create(1);
  migrateAuthSessions(db, 2_000_000);
  assert.equal(db.prepare<{ value: string }>("SELECT value FROM app_config WHERE key='auth.token_epoch'").get()?.value, '4');
  assert.equal(db.prepare('SELECT * FROM users').all().length, 2);
  assert.equal(db.prepare('SELECT * FROM schema_migrations').all().length, 1);
  assert.equal(store.authenticate(a.secret)?.id, a.session.id);
});

test('K-07/K-11: a copied cookie stays valid but a browser change is audited without raw header text', (t) => {
  const { store, db } = fixture(t);
  const a = store.create(1, 'Firefox/1');
  store.touch(a.session.id, 'Chrome/1 synthetic-private-header');
  assert.equal(store.authenticate(a.secret)?.id, a.session.id);
  assert.equal(store.list(1)[0].browser, 'Chrome');
  const events = JSON.stringify(db.prepare('SELECT * FROM auth_events').all());
  assert.ok(events.includes('browser-changed'));
  assert.ok(!events.includes('synthetic-private-header'));
  assert.ok(!events.includes(a.secret));
});
