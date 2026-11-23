/**
 * Tab tokens on the Controller (contracts section 3): the short-lived credential a sandboxed tab uses
 * for `/r/<peerId>/**`. The cryptography lives in the auth module (a token signed with a key derived
 * from the main secret and the auth epoch, so the stock JWT middleware refuses it and "log out
 * everywhere" kills it); this service adds what the Remote routes need on top:
 *
 * - issue only for a peer this Controller has, and only a few times a minute per (user, peer): the
 *   server cannot tell frames apart (each frame already limits itself to one `token-expired` per
 *   minute), so this is a guard against a runaway client rather than the per-frame rule;
 * - authenticate = verify the token for exactly this peer AND load the account, because the auth
 *   module's `verifyTabToken` does not check that the user still exists.
 */

import { issueTabToken, verifyTabToken } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 10;
const MAX_TRACKED_BUCKETS = 1024;

export type TabTokenServiceOptions = {
  /** True when this Controller has a pairing with that id. */
  hasPeer(peerId: string): boolean;
  /** True when that pairing's `expires_at` has passed: no token is issued for it (410 `REMOTE_PEER_EXPIRED`). */
  isExpired?(peerId: string): boolean;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
  maxPerMinute?: number;
};

/** Who a tab token speaks for once it checked out. */
export type TabIdentity = { id: number; username: string; sessionId: string };

export type TabAuthentication = { ok: true; user: TabIdentity } | { ok: false; reason: 'expired' | 'invalid' };

/**
 * Creates the Controller's tab token service.
 * Consumed by: the Controller proxy (HTTP), the WebSocket gateway and the management API (`tab-token`).
 */
export function createTabTokenService({ hasPeer, isExpired, now = Date.now, maxPerMinute = DEFAULT_MAX_PER_MINUTE }: TabTokenServiceOptions) {
  const issued = new Map<string, number[]>();

  const prune = (at: number): void => {
    for (const [key, times] of issued) {
      if (times.every((time) => at - time >= WINDOW_MS)) issued.delete(key);
    }
  };

  return {
    /** Issues a token for `peerId`; throws `AppError` 404 `REMOTE_PEER_NOT_FOUND`, 410 `REMOTE_PEER_EXPIRED` or 429 `REMOTE_QUOTA`. */
    issue(input: { userId: number; username: string; peerId: string; sessionId: string }): { tabToken: string; expiresAt: number } {
      if (!hasPeer(input.peerId)) {
        throw new AppError('No such paired Host.', { statusCode: 404, code: 'REMOTE_PEER_NOT_FOUND' });
      }
      if (isExpired?.(input.peerId)) {
        throw new AppError('This pairing has expired. Pair the Host again.', { statusCode: 410, code: 'REMOTE_PEER_EXPIRED' });
      }
      const at = now();
      const key = `${input.userId}|${input.peerId}`;
      const recent = (issued.get(key) ?? []).filter((time) => at - time < WINDOW_MS);
      if (recent.length >= maxPerMinute) {
        const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - at) / 1000));
        throw new AppError('Too many tab tokens requested. Try again shortly.', {
          statusCode: 429,
          code: 'REMOTE_QUOTA',
          details: { retryAfterSeconds },
        });
      }
      recent.push(at);
      issued.set(key, recent);
      if (issued.size > MAX_TRACKED_BUCKETS) prune(at);

      const tabToken = issueTabToken(input);
      const verified = verifyTabToken(tabToken, input.peerId);
      if (!verified.ok) throw new AppError('Could not issue a tab token.', { statusCode: 500, code: 'INTERNAL_ERROR' });
      return { tabToken, expiresAt: verified.claims.exp * 1000 };
    },

    /** Accepts only an unexpired tab token of this epoch issued for `peerId` whose account still exists. */
    authenticate(token: string, peerId: string): TabAuthentication {
      if (typeof token !== 'string' || token === '') return { ok: false, reason: 'invalid' };
      const verified = verifyTabToken(token, peerId);
      if (!verified.ok) return verified;
      const user = userDb.getUserById(verified.claims.userId);
      if (!user) return { ok: false, reason: 'invalid' };
      return { ok: true, user: { id: user.id, username: user.username, sessionId: verified.claims.sid } };
    },

    /** Number of (user, peer) buckets in memory; for tests of the bound. */
    trackedBuckets: (): number => issued.size,
  };
}

export type TabTokenService = ReturnType<typeof createTabTokenService>;
