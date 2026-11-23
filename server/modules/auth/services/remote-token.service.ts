import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { getSessionRuntime } from './session-runtime.service.js';

export { issueLoopbackToken } from './loopback-token.service.js';
import { getJwtSecret } from '../auth.middleware.js';

import { getAuthEpoch } from './auth-epoch.service.js';

export const TAB_TOKEN_MAX_AGE_SECONDS = 900;
const TAB_TOKEN_KEY_LABEL = 'remotecli/v1/tab-token';

export type TabTokenClaims = {
  typ: 'remote-tab';
  sid: string;
  peerId: string;
  userId: number;
  username: string;
  iat: number;
  exp: number;
};

export type TabTokenVerification =
  | { ok: true; claims: TabTokenClaims }
  | { ok: false; reason: 'expired' | 'invalid' };

/**
 * Tab tokens are signed with a key derived from the main secret AND the auth epoch, under a
 * fixed label. Cookie authentication never accepts these credentials; moving the epoch
 * invalidates them independently of their parent browser sessions.
 */
function deriveTabTokenKey(label: string = TAB_TOKEN_KEY_LABEL): Buffer {
  return crypto
    .createHmac('sha256', `${getJwtSecret()}|${getAuthEpoch()}`)
    .update(label)
    .digest();
}

/** Short-lived token the Controller hands to a sandboxed tab; only valid for `/r/**` of one peer. */
export function issueTabToken(input: {
  userId: number;
  username: string;
  peerId: string;
  sessionId: string;
  ttlSeconds?: number;
}): string {
  const parent = getSessionRuntime().store.getActive(input.sessionId);
  if (!parent || parent.userId !== input.userId) throw new Error('An active parent session is required');
  const requested = input.ttlSeconds ?? TAB_TOKEN_MAX_AGE_SECONDS;
  const ttl = Math.max(1, Math.min(Math.floor(requested), TAB_TOKEN_MAX_AGE_SECONDS));
  return jwt.sign(
    { typ: 'remote-tab', sid: input.sessionId, peerId: input.peerId, userId: input.userId, username: input.username },
    deriveTabTokenKey(),
    { algorithm: 'HS256', expiresIn: ttl },
  );
}

/** Accepts only an unexpired tab token of the current epoch that was issued for `peerId`. */
export function verifyTabToken(token: string, peerId: string): TabTokenVerification {
  const tryVerify = (key: Buffer): TabTokenVerification => {
    try {
      const claims = jwt.verify(token, key, { algorithms: ['HS256'] }) as TabTokenClaims;
      if (
        claims.typ !== 'remote-tab'
        || typeof claims.sid !== 'string'
        || getSessionRuntime().store.getActive(claims.sid)?.userId !== claims.userId
        || claims.peerId !== peerId
        || typeof claims.userId !== 'number'
        || typeof claims.exp !== 'number' || typeof claims.iat !== 'number'
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > TAB_TOKEN_MAX_AGE_SECONDS
      ) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, claims };
    } catch (error) {
      return { ok: false, reason: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' };
    }
  };

  return tryVerify(deriveTabTokenKey());
}
