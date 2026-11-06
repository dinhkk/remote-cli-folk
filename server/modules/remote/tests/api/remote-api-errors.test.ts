/**
 * The JSON errors of the management API (contracts sections 9 and 10): every known domain error becomes
 * `{success:false, error:{code, message, details?}}` with the documented status; anything unknown is
 * passed on untouched so the server's global handler answers a generic 500 that leaks nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { remoteErrorHandler } from '../../api/remote-api-errors.js';
import { InvalidPairCodeError } from '../../crypto/key-derivation.js';
import { SecretBoxError } from '../../crypto/secret-box.js';
import { RemoteLinkDownError } from '../../link/relay-link.js';
import { PairingError } from '../../pairing/pairing-host.service.js';
import { RemoteConfigError } from '../../storage/remote-storage.service.js';
import { send, serve, type RunningServer } from '../support/http-test-client.js';

type Failure = { success: false; error: { code: string; message: string; details?: unknown } };

const withApp = async (run: (call: (path: string, body?: string) => ReturnType<typeof send>) => Promise<void>): Promise<void> => {
  const throwing = (error: () => unknown): express.RequestHandler => (_req, _res, next) => next(error());
  const app = express();
  app.post('/json', express.json({ limit: '100b' }), (_req, res) => res.json({ ok: true }));
  app.get('/app-error', throwing(() => new AppError('Nope.', { statusCode: 418, code: 'TEAPOT', details: { why: 'because' } })));
  app.get('/rate-limited', throwing(() => new AppError('Slow down.', { statusCode: 429, code: 'AUTH_RATE_LIMITED', details: { retryAfterSeconds: 42 } })));
  app.get('/rate-limited-bare', throwing(() => new AppError('Slow down.', { statusCode: 429, code: 'AUTH_RATE_LIMITED' })));
  app.get('/pair-locked', throwing(() => new PairingError('PAIRING_LOCKED', 'Locked.', 1234)));
  app.get('/pair-full', throwing(() => new PairingError('PAIRING_LIMIT', 'Full.')));
  app.get('/pair-missing', throwing(() => new PairingError('PAIRING_NOT_FOUND', 'Missing.')));
  app.get('/pair-not-ready', throwing(() => new PairingError('PAIRING_NOT_READY', 'Not ready.')));
  app.get('/pair-sas', throwing(() => new PairingError('INVALID_SAS', 'Six digits.')));
  app.get('/pair-code', throwing(() => new InvalidPairCodeError()));
  app.get('/config-url', throwing(() => new RemoteConfigError('INVALID_RELAY_URL', 'Bad URL.')));
  app.get('/config-secret', throwing(() => new RemoteConfigError('INVALID_RELAY_SECRET', 'Bad secret.')));
  app.get('/key-mismatch', throwing(() => new SecretBoxError('MASTER_KEY_MISMATCH', 'The key changed.')));
  app.get('/key-invalid', throwing(() => new SecretBoxError('MASTER_KEY_INVALID', 'The key is malformed.')));
  app.get('/box-other', throwing(() => new SecretBoxError('decrypt-failed', 'Cannot open.')));
  app.get('/link-down', throwing(() => new RemoteLinkDownError()));
  app.get('/plain', throwing(() => new Error('internal detail that must not leak')));
  app.get('/odd-type', throwing(() => Object.assign(new Error('x'), { type: 'something.else' })));
  app.get('/after-head', (_req, res, next) => {
    res.write('partial');
    next(new AppError('Too late.', { statusCode: 500, code: 'LATE' }));
  });
  app.use(remoteErrorHandler);
  // What the server's global handler does with what the Remote handler passes on.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(599).json({ passedOn: true, name: (error as Error).name });
  });
  const server: RunningServer = await serve(app);
  try {
    await run((path, body) =>
      send(server.port, body === undefined ? { path } : { method: 'POST', path, headers: { 'content-type': 'application/json' }, body }),
    );
  } finally {
    await server.close();
  }
};

const failure = (response: { json<T>(): T }): Failure['error'] => response.json<Failure>().error;

describe('management API errors', () => {
  it('keeps an AppError as it is, including details, in the standard envelope', async () => {
    await withApp(async (call) => {
      const response = await call('/app-error');
      assert.equal(response.status, 418);
      assert.deepEqual(response.json(), { success: false, error: { code: 'TEAPOT', message: 'Nope.', details: { why: 'because' } } });
    });
  });

  it('adds Retry-After to a rate-limit refusal that carries the delay, and not to one that does not', async () => {
    await withApp(async (call) => {
      const withDelay = await call('/rate-limited');
      assert.equal(withDelay.status, 429);
      assert.equal(withDelay.headers['retry-after'], '42');
      assert.equal((await call('/rate-limited-bare')).headers['retry-after'], undefined);
    });
  });

  it('maps every pairing error to its REMOTE_PAIR_* code and status; only the lock carries details', async () => {
    await withApp(async (call) => {
      const expected: Array<[string, number, string]> = [
        ['/pair-locked', 423, 'REMOTE_PAIR_LOCKED'],
        ['/pair-full', 409, 'REMOTE_PAIR_FULL'],
        ['/pair-missing', 404, 'REMOTE_PAIR_NOT_FOUND'],
        ['/pair-not-ready', 409, 'REMOTE_PAIR_NOT_READY'],
        ['/pair-sas', 400, 'REMOTE_PAIR_INVALID_SAS'],
      ];
      for (const [path, status, code] of expected) {
        const response = await call(path);
        assert.equal(response.status, status, path);
        assert.equal(failure(response).code, code, path);
        assert.equal('details' in failure(response), path === '/pair-locked', path);
      }
      assert.deepEqual(failure(await call('/pair-locked')).details, { lockedUntil: 1234 });
    });
  });

  it('maps a malformed pairing code, bad relay settings, a master key problem and a down link', async () => {
    await withApp(async (call) => {
      const expected: Array<[string, number, string]> = [
        ['/pair-code', 400, 'REMOTE_PAIR_CODE_INVALID'],
        ['/config-url', 400, 'INVALID_RELAY_URL'],
        ['/config-secret', 400, 'INVALID_RELAY_SECRET'],
        ['/key-mismatch', 409, 'MASTER_KEY_MISMATCH'],
        ['/key-invalid', 409, 'MASTER_KEY_INVALID'],
        ['/link-down', 503, 'REMOTE_LINK_DOWN'],
      ];
      for (const [path, status, code] of expected) {
        const response = await call(path);
        assert.equal(response.status, status, path);
        assert.equal(failure(response).code, code, path);
      }
    });
  });

  it('answers a body that is too large with 413 and one that is not JSON with 400', async () => {
    await withApp(async (call) => {
      const large = await call('/json', JSON.stringify({ pad: 'x'.repeat(300) }));
      assert.equal(large.status, 413);
      assert.equal(failure(large).code, 'REMOTE_TOO_LARGE');
      const broken = await call('/json', '{"pad":');
      assert.equal(broken.status, 400);
      assert.equal(failure(broken).code, 'REMOTE_BAD_REQUEST');
    });
  });

  it('passes on what it does not know (and what cannot be answered any more) without describing it', async () => {
    await withApp(async (call) => {
      for (const path of ['/plain', '/odd-type', '/box-other']) {
        const response = await call(path);
        assert.equal(response.status, 599, path);
        assert.ok(!response.text().includes('internal detail'), 'the message of an unknown error never reaches the client');
      }
      const late = await call('/after-head');
      assert.equal(late.status, 200, 'the head was already sent; the handler leaves the response alone');
    });
  });
});
