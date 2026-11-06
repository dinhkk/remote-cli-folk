/**
 * Tab tokens as the Controller hands them out and checks them (contracts section 3): issued only for a
 * peer this Controller really has, valid for at most 15 minutes and for exactly one peer, never
 * interchangeable with the main JWT in either direction, dead after "log out everywhere", and bounded
 * in how often one (user, peer) can ask for a new one.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { verifyTabToken } from '@/modules/auth/index.js';

import { createTabTokenService } from '../../controller/tab-token.service.js';
import { createTestAccount, logoutEverywhere, type TestAccount } from '../support/auth-test-session.js';
import { withTempDatabase } from '../support/temp-database.js';

const jwt = createRequire(import.meta.url)('jsonwebtoken') as { decode(token: string): { iat: number; exp: number; peerId: string; typ: string } };

const withService = async (
  options: { peers?: string[]; maxPerMinute?: number },
  run: (ctx: { service: ReturnType<typeof createTabTokenService>; user: TestAccount; clock: { now: number } }) => void | Promise<void>,
): Promise<void> =>
  withTempDatabase(async () => {
    const user = await createTestAccount('alice');
    const clock = { now: 1_000_000 };
    const peers = new Set(options.peers ?? ['peer-1', 'peer-2']);
    const service = createTabTokenService({ hasPeer: (id) => peers.has(id), now: () => clock.now, maxPerMinute: options.maxPerMinute });
    await run({ service, user, clock });
  });

describe('tab token service', () => {
  it('issues a token for one peer that lives at most 900 seconds and verifies only for that peer', async () => {
    await withService({}, ({ service, user }) => {
      const grant = service.issue({ userId: user.id, username: user.username, peerId: 'peer-1' });
      const claims = jwt.decode(grant.tabToken);
      assert.equal(claims.typ, 'remote-tab');
      assert.equal(claims.peerId, 'peer-1');
      assert.ok(claims.exp - claims.iat <= 900);
      assert.equal(grant.expiresAt, claims.exp * 1000);
      assert.equal(verifyTabToken(grant.tabToken, 'peer-1').ok, true);
      assert.equal(verifyTabToken(grant.tabToken, 'peer-2').ok, false);
    });
  });

  it('refuses to issue for a peer this Controller does not have', async () => {
    await withService({}, ({ service, user }) => {
      assert.throws(
        () => service.issue({ userId: user.id, username: user.username, peerId: 'nobody' }),
        (error: { code?: string; statusCode?: number }) => error.code === 'REMOTE_PEER_NOT_FOUND' && error.statusCode === 404,
      );
    });
  });

  it('authenticates a tab token for its own peer and returns the account it belongs to', async () => {
    await withService({}, ({ service, user }) => {
      const { tabToken } = service.issue({ userId: user.id, username: user.username, peerId: 'peer-1' });
      const verdict = service.authenticate(tabToken, 'peer-1');
      assert.equal(verdict.ok, true);
      assert.deepEqual(verdict.ok && verdict.user, { id: user.id, username: 'alice' });
    });
  });

  it("refuses another peer's token, garbage, and a token for a user that no longer exists", async () => {
    await withService({}, ({ service, user }) => {
      const { tabToken } = service.issue({ userId: user.id, username: user.username, peerId: 'peer-1' });
      assert.equal(service.authenticate(tabToken, 'peer-2').ok, false);
      assert.equal(service.authenticate('not-a-token', 'peer-1').ok, false);
      assert.equal(service.authenticate('', 'peer-1').ok, false);
      const ghost = service.issue({ userId: 9999, username: 'ghost', peerId: 'peer-1' });
      assert.equal(service.authenticate(ghost.tabToken, 'peer-1').ok, false, 'verifyTabToken does not check the account; the service must');
    });
  });

  it('refuses the full JWT on /r (AC-25): it is not a tab token', async () => {
    await withService({}, ({ service, user }) => {
      assert.equal(service.authenticate(user.jwt, 'peer-1').ok, false);
    });
  });

  it('a token from before "log out everywhere" is refused', async () => {
    await withService({}, async ({ service, user }) => {
      const { tabToken } = service.issue({ userId: user.id, username: user.username, peerId: 'peer-1' });
      assert.equal(service.authenticate(tabToken, 'peer-1').ok, true);
      await logoutEverywhere(user);
      assert.equal(service.authenticate(tabToken, 'peer-1').ok, false);
    });
  });

  it('limits how often one (user, peer) can obtain a token, per rolling minute, and recovers', async () => {
    await withService({ maxPerMinute: 3 }, ({ service, user, clock }) => {
      const ask = (peerId = 'peer-1') => service.issue({ userId: user.id, username: user.username, peerId });
      ask();
      ask();
      ask();
      assert.throws(ask, (error: { code?: string; statusCode?: number; details?: { retryAfterSeconds?: number } }) => {
        return error.code === 'REMOTE_QUOTA' && error.statusCode === 429 && Number(error.details?.retryAfterSeconds) > 0;
      });
      // Another peer has its own budget.
      assert.doesNotThrow(() => ask('peer-2'));
      clock.now += 61_000;
      assert.doesNotThrow(() => ask());
    });
  });

  it('forgets idle buckets so the limiter cannot grow without bound', async () => {
    await withService({ maxPerMinute: 1 }, ({ service, user, clock }) => {
      for (let i = 0; i < 2000; i += 1) {
        service.issue({ userId: user.id + i, username: `u${i}`, peerId: 'peer-1' });
        clock.now += 61_000;
      }
      assert.ok(service.trackedBuckets() <= 1025, `tracked ${service.trackedBuckets()}`);
    });
  });
});
