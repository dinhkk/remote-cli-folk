import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

import { createAuthRouter } from '../auth.routes.js';

type Service = Parameters<typeof createAuthRouter>[0];

const allowAll: RequestHandler = (req, _res, next) => {
  (req as Request & { user?: unknown }).user = { id: 1, username: 'alice' };
  next();
};

async function withRouter(
  service: Partial<Record<keyof Service, unknown>>,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(service as Service, allowAll));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: { code: err.code, details: err.details } });
      return;
    }
    res.status(500).json({ error: 'unexpected' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('a rate limited login answers 429 with a Retry-After header', async () => {
  const service = {
    login: async () => {
      throw new AppError('Too many attempts', {
        code: 'AUTH_RATE_LIMITED',
        statusCode: 429,
        details: { retryAfterSeconds: 120 },
      });
    },
  };

  await withRouter(service, async (baseUrl) => {
    const response = await post(`${baseUrl}/api/auth/login`, { username: 'alice', password: 'x' });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '120');
  });
});

test('login hands the client IP to the service', async () => {
  let seenIp: unknown;
  const service = {
    login: async (_u: unknown, _p: unknown, ip: unknown) => {
      seenIp = ip;
      return { success: true };
    },
  };

  await withRouter(service, async (baseUrl) => {
    await post(`${baseUrl}/api/auth/login`, { username: 'alice', password: 'x' });
  });

  assert.match(String(seenIp), /127\.0\.0\.1$/);
});

test('register takes the setup token from the body or the x-setup-token header', async () => {
  const seen: unknown[] = [];
  const service = {
    register: async (_u: unknown, _p: unknown, setupToken: unknown) => {
      seen.push(setupToken);
      return { success: true };
    },
  };

  await withRouter(service, async (baseUrl) => {
    await post(`${baseUrl}/api/auth/register`, { username: 'alice', password: 'x', setupToken: 'from-body' });
    await post(`${baseUrl}/api/auth/register`, { username: 'alice', password: 'x' }, { 'x-setup-token': 'from-header' });
    await post(`${baseUrl}/api/auth/register`, { username: 'alice', password: 'x' });
  });

  assert.deepEqual(seen, ['from-body', 'from-header', undefined]);
});

test('POST /logout-all passes the authenticated user, password and IP to the service', async () => {
  let call: unknown[] = [];
  const service = {
    logoutAll: async (...args: unknown[]) => {
      call = args;
      return { success: true, rotated: true };
    },
  };

  await withRouter(service, async (baseUrl) => {
    const response = await post(`${baseUrl}/api/auth/logout-all`, { password: 'correct-horse-battery' });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, rotated: true });
  });

  assert.deepEqual(call[0], { id: 1, username: 'alice' });
  assert.equal(call[1], 'correct-horse-battery');
  assert.match(String(call[2]), /127\.0\.0\.1$/);
});

test('logout-all and the other protected routes sit behind authenticateToken', async () => {
  let reached = false;
  const service = {
    logoutAll: async () => { reached = true; return { success: true }; },
    refreshSession: () => { reached = true; return {}; },
    getCurrentUser: () => { reached = true; return {}; },
    logout: () => { reached = true; return {}; },
  };
  const rejectAll: RequestHandler = (_req, res) => {
    res.status(401).json({ error: 'no token' });
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(service as unknown as Service, rejectAll));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
    const statuses = [
      (await post(`${base}/logout-all`, { password: 'x' })).status,
      (await post(`${base}/refresh`, {})).status,
      (await post(`${base}/logout`, {})).status,
      (await fetch(`${base}/user`)).status,
    ];
    assert.deepEqual(statuses, [401, 401, 401, 401]);
    assert.equal(reached, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a pinned secret surfaces as 409 from logout-all', async () => {
  const service = {
    logoutAll: async () => {
      throw new AppError('JWT_SECRET is set by env', { code: 'AUTH_SECRET_PINNED', statusCode: 409 });
    },
  };

  await withRouter(service, async (baseUrl) => {
    const response = await post(`${baseUrl}/api/auth/logout-all`, { password: 'x' });
    assert.equal(response.status, 409);
  });
});
