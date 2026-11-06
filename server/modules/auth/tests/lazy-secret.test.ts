import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('importing auth.middleware opens no database; DATABASE_PATH set afterwards is honoured', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-lazy-'));
  const databasePath = path.join(tempDirectory, 'late.db');
  const previousJwtSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;

  const connection = await import('@/modules/database/index.js');
  connection.closeConnection();
  delete process.env.DATABASE_PATH;

  try {
    const middleware = await import('../auth.middleware.js');
    process.env.DATABASE_PATH = databasePath;

    assert.equal(existsSync(databasePath), false, 'import must not have created the database');

    const secret = middleware.getJwtSecret();

    assert.ok(secret.length >= 32);
    assert.equal(existsSync(databasePath), true, 'the secret was read from the late DATABASE_PATH');
    assert.equal(middleware.getJwtSecret(), secret, 'stable across calls (cached)');
  } finally {
    connection.closeConnection();
    delete process.env.DATABASE_PATH;
    if (previousJwtSecret !== undefined) {
      process.env.JWT_SECRET = previousJwtSecret;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('a JWT_SECRET env override wins and is read at call time', async () => {
  const previous = process.env.JWT_SECRET;
  try {
    const middleware = await import('../auth.middleware.js');
    process.env.JWT_SECRET = 'env-secret-one';
    assert.equal(middleware.getJwtSecret(), 'env-secret-one');
    process.env.JWT_SECRET = 'env-secret-two';
    assert.equal(middleware.getJwtSecret(), 'env-secret-two');
  } finally {
    if (previous === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previous;
    }
  }
});
