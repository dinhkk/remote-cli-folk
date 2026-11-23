import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TOTP } from 'otpauth';

import { closeConnection, initializeDatabase } from '../../database/index.js';
import { getMfaStore, initializeMfa } from '../services/mfa-runtime.service.js';
import { getSessionRuntime } from '../services/session-runtime.service.js';

import { withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

test('T-02/Q-06: missing master key fails MFA startup without replacement; restoring it permits login', async () => {
  const names = ['REMOTECLI_MASTER_KEY', 'CLOUDCLI_REMOTE_MASTER_KEY', 'REMOTECLI_MASTER_KEY_FILE'];
  const previous = names.map(name => process.env[name]);
  try {
    delete process.env.REMOTECLI_MASTER_KEY;
    delete process.env.CLOUDCLI_REMOTE_MASTER_KEY;
    await withIsolatedAuthDatabase(async user => {
      const keyPath = path.join(path.dirname(process.env.DATABASE_PATH!), 'test-master.key');
      process.env.REMOTECLI_MASTER_KEY_FILE = keyPath;
      initializeMfa();
      const session = getSessionRuntime().store.create(user.id).session;
      const store = getMfaStore();
      const enrollment = store.beginEnrollment(user.id, user.username, session.id);
      const totp = new TOTP({ secret: enrollment.secret, digits: 6, period: 30 });
      const timestamp = Date.now();
      store.activate(user.id, session.id, totp.generate({ timestamp }));
      const savedKey = readFileSync(keyPath);

      // Reopen the database so neither the MFA store nor the master-key cache survives.
      closeConnection();
      unlinkSync(keyPath);
      await initializeDatabase();
      assert.throws(() => initializeMfa(), (error: unknown) =>
        (error as { code?: string }).code === 'MASTER_KEY_MISMATCH');
      assert.equal(existsSync(keyPath), false, 'startup must not generate a replacement key');

      closeConnection();
      writeFileSync(keyPath, savedKey, { mode: 0o600 });
      await initializeDatabase();
      initializeMfa();
      const restored = getMfaStore();
      const challenge = restored.challenge(user.id)!;
      // The next accepted step avoids replaying the code consumed by activation.
      const login = restored.completeLogin(challenge.challenge, totp.generate({ timestamp: timestamp + 30_000 }), false);
      assert.equal(login.userId, user.id);
      assert.ok(login.verifiedAt > 0);
      assert.deepEqual(readFileSync(keyPath), savedKey);
    });
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
