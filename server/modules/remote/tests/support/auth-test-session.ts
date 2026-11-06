/**
 * Real logins for the Remote tests, through the auth module's own routes (the only way the module's
 * barrel offers to get a JWT): an account with a real password hash is created in the current database,
 * `POST /api/auth/login` returns its token, and `POST /api/auth/logout-all` is the real "log out
 * everywhere" (it bumps the auth epoch and rotates the JWT secret unless `JWT_SECRET` pins it).
 */

import { createRequire } from 'node:module';

import express from 'express';

import { authRoutes } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';

import { send, serve } from './http-test-client.js';

const bcrypt = createRequire(import.meta.url)('bcrypt') as { hash(password: string, rounds: number): Promise<string> };

export const TEST_PASSWORD = 'correct horse battery staple';

// The login limiter is process-wide and keyed by (address, username): every account is new.
let accountCounter = 0;

export type TestAccount = { id: number; username: string; password: string; jwt: string };

const withAuthApp = async <T>(run: (port: number) => Promise<T>): Promise<T> => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = await serve(app);
  try {
    return await run(server.port);
  } finally {
    await server.close();
  }
};

const post = (port: number, path: string, body: unknown, jwt?: string) =>
  send(port, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  });

/** Logs `username` in (a fresh JWT of the current secret). */
export const login = async (username: string, password = TEST_PASSWORD): Promise<string> =>
  withAuthApp(async (port) => {
    const response = await post(port, '/api/auth/login', { username, password });
    if (response.status !== 200) throw new Error(`test login failed: ${response.status}`);
    return response.json<{ token: string }>().token;
  });

/** Creates an account in the current database and logs it in. */
export const createTestAccount = async (username?: string): Promise<TestAccount> => {
  accountCounter += 1;
  const name = username ?? `account${accountCounter}`;
  const created = userDb.createUser(name, await bcrypt.hash(TEST_PASSWORD, 4));
  return { id: Number(created.id), username: name, password: TEST_PASSWORD, jwt: await login(name) };
};

/**
 * "Log out everywhere" as the account owner does it. Returns the HTTP status: 200 when the JWT secret was
 * rotated, 409 (`AUTH_SECRET_PINNED`) when `JWT_SECRET` pins it; either way the auth epoch moved.
 */
export const logoutEverywhere = async (account: TestAccount): Promise<number> =>
  withAuthApp(async (port) => (await post(port, '/api/auth/logout-all', { password: account.password }, account.jwt)).status);
