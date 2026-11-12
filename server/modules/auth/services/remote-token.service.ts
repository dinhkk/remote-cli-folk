import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { userDb } from '../../database/index.js';
import { getJwtSecret } from '../auth.middleware.js';

import { getAuthEpoch } from './auth-epoch.service.js';

export const TAB_TOKEN_MAX_AGE_SECONDS = 900;
const LOOPBACK_TOKEN_TTL_SECONDS = 300;
const TAB_TOKEN_KEY_LABEL = 'remotecli/v1/tab-token';
const LEGACY_TAB_TOKEN_KEY_LABEL = 'cloudcli-remote/v1/tab-token';

export type TabTokenClaims = {
  typ: 'remote-tab';
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
 * fixed label. A different key is what makes the stock `jwt.verify(token, mainSecret)` in
 * authenticateToken/authenticateWebSocket reject them, and what kills them when the epoch moves.
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
  ttlSeconds?: number;
}): string {
  const requested = input.ttlSeconds ?? TAB_TOKEN_MAX_AGE_SECONDS;
  const ttl = Math.max(1, Math.min(Math.floor(requested), TAB_TOKEN_MAX_AGE_SECONDS));
  return jwt.sign(
    { typ: 'remote-tab', peerId: input.peerId, userId: input.userId, username: input.username },
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
        || claims.peerId !== peerId
        || typeof claims.userId !== 'number'
        || claims.exp - claims.iat > TAB_TOKEN_MAX_AGE_SECONDS
      ) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, claims };
    } catch (error) {
      return { ok: false, reason: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' };
    }
  };

  const primary = tryVerify(deriveTabTokenKey(TAB_TOKEN_KEY_LABEL));
  if (primary.ok || primary.reason === 'expired') return primary;

  // Fallback to legacy key label for rolling upgrades
  const fallback = tryVerify(deriveTabTokenKey(LEGACY_TAB_TOKEN_KEY_LABEL));
  return fallback.ok ? fallback : primary;
}

/**
 * Ordinary short-lived JWT for the Host bridge's own loopback requests. Issued fresh for every
 * request/WebSocket (never cached) and never leaves this process; the stock middleware accepts
 * it as a normal login token, and `jti` makes each one unique.
 */
export function issueLoopbackToken(): string {
  const user = userDb.getFirstUser();
  if (!user) {
    throw new Error('Cannot issue a loopback token: no user exists yet');
  }
  return jwt.sign({ userId: user.id, username: user.username }, getJwtSecret(), {
    expiresIn: LOOPBACK_TOKEN_TTL_SECONDS,
    jwtid: crypto.randomUUID(),
  });
}
