import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection } from '../../database/index.js';
import { assertAuthModeCompatible } from '../services/auth-mode.service.js';
import { getSessionRuntime, startSessionExpiry } from '../services/session-runtime.service.js';
import { SESSION_MAX_AGE_MS } from '../services/session-store.service.js';

import { withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

test('L-04: the lifecycle timer expires idle transports without any next request and preserves another device', async (t) => {
  await withIsolatedAuthDatabase((user) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    const { store, connections } = getSessionRuntime();
    const a = store.create(user.id);
    t.mock.timers.tick(2000);
    const b = store.create(user.id);
    const closed: string[] = [];
    for (const kind of ['http', 'sse', 'ws', 'remote-ws']) connections.track(a.session.id, () => closed.push(kind));
    const releaseB = connections.track(b.session.id, () => closed.push('device-b'));
    // Jump close to expiration before starting the timer: avoid millions of interval ticks.
    t.mock.timers.tick(SESSION_MAX_AGE_MS - 3000);
    const stop = startSessionExpiry();
    try {
      assert.deepEqual(closed, []);
      t.mock.timers.tick(1000);
      assert.deepEqual(closed.sort(), ['http', 'remote-ws', 'sse', 'ws']);
      assert.ok(store.authenticate(b.secret));
      assert.equal(store.authenticate(a.secret), null);
      let lateClosed = false;
      connections.track(a.session.id, () => { lateClosed = true; });
      assert.equal(lateClosed, true, 'a late reattach cannot revive an expired session');
    } finally { stop(); releaseB(); t.mock.timers.reset(); }
  });
});

test('G-03: platform startup rejects enabled TOTP and permits an installation without TOTP', async () => {
  await withIsolatedAuthDatabase(() => {
    const db = getConnection();
    assert.doesNotThrow(() => assertAuthModeCompatible(db, true));
    db.exec('CREATE TABLE auth_totp (user_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)');
    db.exec('INSERT INTO auth_totp VALUES (1, 0)');
    assert.doesNotThrow(() => assertAuthModeCompatible(db, true));
    db.exec('UPDATE auth_totp SET enabled = 1');
    assert.throws(() => assertAuthModeCompatible(db, true), /cannot be used while TOTP/);
    assert.doesNotThrow(() => assertAuthModeCompatible(db, false));
  });
});
