import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { getConnection } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { DUMMY_PASSWORD_HASH, authRoutes, verifyPassword } from '../auth.module.js';

import { withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs') as {
  hash(password: string, rounds: number): Promise<string>;
  getRounds(hash: string): number;
};

async function setAlicePassword(userId: number, password: string) {
  // Cost 4 keeps the test fast; verifyPassword only cares that compare() succeeds or not.
  const hash = await bcrypt.hash(password, 4);
  getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

test('the dummy hash is a well-formed cost-12 bcrypt hash (a malformed one would return instantly)', () => {
  assert.match(DUMMY_PASSWORD_HASH, /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
  assert.equal(bcrypt.getRounds(DUMMY_PASSWORD_HASH), 12);
});

test('verifyPassword accepts the right password and rejects wrong ones and unknown ids', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    await setAlicePassword(user.id, 'correct-horse-battery');

    assert.equal(await verifyPassword(user.id, 'correct-horse-battery'), true);
    assert.equal(await verifyPassword(user.id, 'wrong-password-here'), false);
    assert.equal(await verifyPassword(user.id + 999, 'correct-horse-battery'), false);
  });
});

test('verifyPassword is not a password oracle: five wrong guesses lock it with a 429 until the right one lands', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    await setAlicePassword(user.id, 'correct-horse-battery');

    for (let i = 0; i < 5; i += 1) {
      assert.equal(await verifyPassword(user.id, `wrong-guess-${i}`, '10.9.9.9'), false);
    }
    await assert.rejects(
      verifyPassword(user.id, 'correct-horse-battery', '10.9.9.9'),
      (error: unknown) => error instanceof AppError && error.code === 'AUTH_RATE_LIMITED' && error.statusCode === 429,
    );
    assert.equal(await verifyPassword(user.id, 'correct-horse-battery', '10.9.9.10'), true, 'other clients unaffected');
  });
});

async function postRegister(body: unknown): Promise<{ status: number; code?: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: { code: err.code } });
      return;
    }
    res.status(500).json({ error: { code: 'UNEXPECTED' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: json.error?.code };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('CLOUDCLI_SETUP_TOKEN from the environment gates register end to end', async () => {
  await withIsolatedAuthDatabase(async () => {
    const previous = process.env.CLOUDCLI_SETUP_TOKEN;
    const credentials = { username: 'bob-the-owner', password: 'a-long-enough-password' };
    try {
      process.env.CLOUDCLI_SETUP_TOKEN = 'setup-secret';
      // The seeded user means a request that passes the token gate ends in "already configured".
      assert.deepEqual(await postRegister(credentials), { status: 403, code: 'AUTH_SETUP_TOKEN_INVALID' });
      assert.deepEqual(await postRegister({ ...credentials, setupToken: 'nope' }), {
        status: 403,
        code: 'AUTH_SETUP_TOKEN_INVALID',
      });
      assert.deepEqual(await postRegister({ ...credentials, setupToken: 'setup-secret' }), {
        status: 403,
        code: 'AUTH_USER_ALREADY_CONFIGURED',
      });

      process.env.CLOUDCLI_SETUP_TOKEN = '';
      assert.deepEqual(await postRegister(credentials), { status: 403, code: 'AUTH_USER_ALREADY_CONFIGURED' });
    } finally {
      if (previous === undefined) {
        delete process.env.CLOUDCLI_SETUP_TOKEN;
      } else {
        process.env.CLOUDCLI_SETUP_TOKEN = previous;
      }
    }
  });
});
