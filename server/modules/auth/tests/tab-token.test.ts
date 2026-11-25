import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import jwt from 'jsonwebtoken';
import { getSessionRuntime } from '../services/session-runtime.service.js';

import {
  authenticateToken,
  authenticateWebSocket,
  generateToken,
  getJwtSecret,
} from '../auth.middleware.js';
import { bumpAuthEpoch, getAuthEpoch } from '../services/auth-epoch.service.js';
import {
  TAB_TOKEN_MAX_AGE_SECONDS,
  issueTabToken,
  verifyTabToken,
} from '../services/remote-token.service.js';

import { runAuthenticateToken, withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

test('a tab token carries the contract claims and lives at most 900 seconds', async () => {
  await withIsolatedAuthDatabase((user) => {
    const token = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'peer-1' });
    const claims = jwt.decode(token) as Record<string, unknown>;

    assert.equal(claims.typ, 'remote-tab');
    assert.equal(claims.peerId, 'peer-1');
    assert.equal(claims.userId, user.id);
    assert.equal(claims.username, 'alice');
    assert.ok((claims.exp as number) - (claims.iat as number) <= TAB_TOKEN_MAX_AGE_SECONDS);
    assert.equal(TAB_TOKEN_MAX_AGE_SECONDS, 900);
    const decoded = jwt.decode(token, { complete: true });
    assert.ok(decoded);
    assert.equal(decoded.header.alg, 'HS256');
  });
});

test('a requested lifetime above 900 seconds is clamped', async () => {
  await withIsolatedAuthDatabase((user) => {
    const token = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'p', ttlSeconds: 86_400 });
    const claims = jwt.decode(token) as { exp: number; iat: number };
    assert.ok(claims.exp - claims.iat <= 900);
  });
});

test('verifyTabToken accepts the right peerId and rejects another', async () => {
  await withIsolatedAuthDatabase((user) => {
    const token = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'peer-1' });

    const ok = verifyTabToken(token, 'peer-1');
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.claims.peerId, 'peer-1');
      assert.equal(ok.claims.userId, user.id);
    }
    assert.deepEqual(verifyTabToken(token, 'peer-2'), { ok: false, reason: 'invalid' });
  });
});

test('an expired tab token is reported as expired', async () => {
  await withIsolatedAuthDatabase((user) => {
    const realNow = Date.now;
    try {
      const token = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'peer-1', ttlSeconds: 60 });
      Date.now = () => realNow() + 61_000;
      assert.deepEqual(verifyTabToken(token, 'peer-1'), { ok: false, reason: 'expired' });
    } finally {
      Date.now = realNow;
    }
  });
});

test('garbage and ordinary JWTs are rejected by verifyTabToken', async () => {
  await withIsolatedAuthDatabase((user) => {
    const main = generateToken(user);

    assert.deepEqual(verifyTabToken('not-a-jwt', 'peer-1'), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifyTabToken(main, 'peer-1'), { ok: false, reason: 'invalid' });
  });
});

test('a token signed with the main secret is rejected (wrong key)', async () => {
  await withIsolatedAuthDatabase((user) => {
    const forged = jwt.sign(
      { typ: 'remote-tab', peerId: 'peer-1', userId: user.id, username: 'alice' },
      getJwtSecret(),
      { expiresIn: 60 },
    );

    assert.deepEqual(verifyTabToken(forged, 'peer-1'), { ok: false, reason: 'invalid' });
  });
});

/** Signs with the genuine derived key, so only the claim checks can reject the result. */
function signWithDerivedKey(claims: Record<string, unknown>, options: jwt.SignOptions) {
  const key = createHmac('sha256', `${getJwtSecret()}|${getAuthEpoch()}`)
    .update('remotecli/v1/tab-token')
    .digest();
  return jwt.sign(claims, key, { algorithm: 'HS256', ...options });
}

test('claim checks reject correctly signed tokens with missing/wrong typ or an over-long lifetime', async () => {
  await withIsolatedAuthDatabase((user) => {
    const base = { sid: getSessionRuntime().store.create(user.id).session.id, typ: 'remote-tab', peerId: 'peer-1', userId: user.id, username: 'alice' };

    assert.equal(verifyTabToken(signWithDerivedKey(base, { expiresIn: 60 }), 'peer-1').ok, true, 'control');
    assert.equal(
      verifyTabToken(signWithDerivedKey({ ...base, typ: undefined }, { expiresIn: 60 }), 'peer-1').ok,
      false,
      'missing typ',
    );
    assert.equal(
      verifyTabToken(signWithDerivedKey({ ...base, typ: 'something-else' }, { expiresIn: 60 }), 'peer-1').ok,
      false,
      'wrong typ',
    );
    assert.equal(
      verifyTabToken(signWithDerivedKey(base, { expiresIn: 86_400 }), 'peer-1').ok,
      false,
      'lifetime above 900 seconds',
    );
    assert.equal(
      verifyTabToken(signWithDerivedKey({ ...base, userId: 'alice' }, { expiresIn: 60 }), 'peer-1').ok,
      false,
      'non-numeric userId',
    );
  });
});

test('the real authenticateToken and authenticateWebSocket reject a tab token', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    const tab = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'peer-1' });

    const rest = await runAuthenticateToken(authenticateToken, tab);
    assert.equal(rest.accepted, false);
    assert.equal(rest.status, 401);
    assert.equal(authenticateWebSocket(tab), null);

    const ordinary = await runAuthenticateToken(authenticateToken, generateToken(user));
    assert.equal(ordinary.accepted, false, 'cookie credentials cannot be replayed as Bearer tokens');
  });
});

test('changing the token epoch kills tab tokens issued before it', async () => {
  await withIsolatedAuthDatabase((user) => {
    const before = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'peer-1' });
    assert.equal(verifyTabToken(before, 'peer-1').ok, true);

    bumpAuthEpoch();

    assert.deepEqual(verifyTabToken(before, 'peer-1'), { ok: false, reason: 'invalid' });
    const after = issueTabToken({ sessionId: getSessionRuntime().store.create(user.id).session.id, userId: user.id, username: user.username, peerId: 'peer-1' });
    assert.equal(verifyTabToken(after, 'peer-1').ok, true);
  });
});
