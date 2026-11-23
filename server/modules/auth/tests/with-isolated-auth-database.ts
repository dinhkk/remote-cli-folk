import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

import { invalidateJwtSecretCache } from '../auth.middleware.js';

/**
 * Runs a test against a throwaway SQLite database with one user ("alice", id returned to the
 * callback) and no JWT_SECRET env override, then restores the process environment.
 */
export async function withIsolatedAuthDatabase(
  run: (user: { id: number; username: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-test-'));

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await writeFile(process.env.DATABASE_PATH, ''); // Do not import a legacy checkout database.
    delete process.env.JWT_SECRET;
    await initializeDatabase();
    invalidateJwtSecretCache();
    const created = userDb.createUser('alice', 'unused-hash');

    await run({ id: Number(created.id), username: 'alice' });
  } finally {
    closeConnection();
    invalidateJwtSecretCache();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Minimal Express response double that records what authenticateToken did. */
export function createResponseRecorder() {
  const recorded = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    once() {},
    destroy() {},
    setHeader(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      recorded.status = code;
      return res;
    },
    json(body: unknown) {
      recorded.body = body;
      return res;
    },
  };
  return { res, recorded };
}

/** Runs the real authenticateToken middleware for a Bearer token and reports the outcome. */
export async function runAuthenticateToken(
  authenticateToken: (req: unknown, res: unknown, next: () => void) => unknown,
  token: string,
): Promise<{ accepted: boolean; status: number; user?: { username: string }; headers: Record<string, string> }> {
  const { res, recorded } = createResponseRecorder();
  const req: { headers: Record<string, string>; query: Record<string, string>; socket: { remoteAddress: string }; user?: { username: string } } = {
    headers: { authorization: `Bearer ${token}` },
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  let accepted = false;
  await authenticateToken(req, res, (error?: unknown) => {
    if (error) throw error;
    accepted = true;
  });
  return { accepted, status: recorded.status, user: req.user, headers: recorded.headers };
}
