import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { TOTP } from 'otpauth';

import { Database } from '../../database/index.js';
import { createSecretBox } from '../../remote/index.js';

import { createSessionStore, migrateAuthSessions } from '../services/session-store.service.js';
import { createSessionConnections } from '../services/session-runtime.service.js';
import { createTotpStore, migrateTotp } from '../services/totp-store.service.js';
import { resetTotp } from '../services/reset-totp.service.js';

test('T-07/L-04: local reset disables MFA, revokes every session and closes tracked transports on sweep', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mfa-reset-test-'));
  const file = path.join(directory, 'auth.db');
  const db = new Database(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1); CREATE TABLE app_config(key TEXT PRIMARY KEY,value TEXT);");
  migrateAuthSessions(db); migrateTotp(db);
  const box = createSecretBox(randomBytes(32));
  const mfa = createTotpStore(db, () => box);
  const sessions = createSessionStore(db);
  const session = sessions.create(1);
  const e = mfa.beginEnrollment(1, 'synthetic-owner', session.session.id);
  mfa.activate(1, session.session.id, new TOTP({ secret: e.secret }).generate());
  sessions.markMfa(session.session.id, Date.now());
  const connections = createSessionConnections(sessions); t.after(() => connections.dispose());
  let closed = 0; connections.track(session.session.id, () => { closed++; });
  resetTotp(file);
  connections.sweep();
  assert.equal(closed, 1); assert.equal(mfa.enabled(1), false);
  assert.equal(sessions.authenticate(session.secret), null);
  assert.equal(db.prepare('SELECT 1 FROM auth_recovery_codes').get(), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
});
