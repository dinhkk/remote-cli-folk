import { createHash, randomBytes } from 'node:crypto';

import { Secret, TOTP } from 'otpauth';

import type { Database } from '../../database/index.js';
import { AppError } from '../../../shared/utils.js';
import { secretAad, type SecretBox } from '../../remote/index.js';

import type { createSessionStore } from './session-store.service.js';

export const MFA_FRESH_MS = 10 * 60 * 1000;
export const MFA_CHALLENGE_MS = 5 * 60 * 1000;
const MAX_BLOCK_MS = 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const aad = (id: number, column: string) => secretAad('auth_totp', column, String(id));
type Row = { user_id: number; enabled: number; seed_sealed: Buffer | null; pending_sealed: Buffer | null; pending_expires_at: number | null; pending_session_id: string | null; last_used_step: number; generation: number };
type Challenge = { userId: number; generation: number; expiresAt: number };

export function migrateTotp(db: Database, at = Date.now()): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS auth_totp (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0,
      seed_sealed BLOB, pending_sealed BLOB, pending_expires_at INTEGER, pending_session_id TEXT,
      last_used_step INTEGER NOT NULL DEFAULT -1, generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_recovery_codes (
      user_id INTEGER NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL,
      used_at INTEGER, PRIMARY KEY(user_id, code_hash)
    );
    CREATE TABLE IF NOT EXISTS auth_throttle (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), failures INTEGER NOT NULL DEFAULT 0,
      block_level INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0
    );`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('auth-totp-v1', at);
  })();
}

/** Account-wide replay protection and persistent throttling, with an injected clock and box. */
export function createTotpStore(db: Database, getBox: () => SecretBox, now: () => number = Date.now) {
  const challenges = new Map<string, Challenge>();
  const row = (id: number) => db.prepare<Row>('SELECT * FROM auth_totp WHERE user_id = ?').get(id);
  const enabled = (id: number) => row(id)?.enabled === 1;
  const invalid = () => new AppError('Invalid or already used verification code', { code: 'MFA_CODE_INVALID', statusCode: 403 });
  const checkThrottle = (id: number) => {
    const until = db.prepare<{ blocked_until: number }>('SELECT blocked_until FROM auth_throttle WHERE user_id = ?').get(id)?.blocked_until ?? 0;
    if (until > now()) throw new AppError('Too many failed attempts. Try again later.', {
      code: 'AUTH_RATE_LIMITED', statusCode: 429, details: { retryAfterSeconds: Math.ceil((until - now()) / 1000) },
    });
  };
  const failure = (id: number) => {
    const old = db.prepare<{ failures: number; block_level: number }>('SELECT * FROM auth_throttle WHERE user_id = ?').get(id);
    const failures = (old?.failures ?? 0) + 1;
    const blocked = failures >= 5;
    const level = old?.block_level ?? 0;
    const until = blocked ? now() + Math.min(5 * 60 * 1000 * 2 ** Math.min(level, 9), MAX_BLOCK_MS) : 0;
    db.prepare(`INSERT INTO auth_throttle (user_id, failures, block_level, blocked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET failures=excluded.failures, block_level=excluded.block_level, blocked_until=excluded.blocked_until`)
      .run(id, blocked ? 0 : failures, blocked ? Math.min(level + 1, 10) : level, until);
  };
  const step = (id: number, sealed: Buffer, column: string, code: unknown): number | null => {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const plaintext = getBox().open(sealed, aad(id, column));
    try {
      const totp = new TOTP({ secret: Secret.fromBase32(plaintext.toString('utf8')), algorithm: 'SHA1', digits: 6, period: 30 });
      const at = now();
      const delta = totp.validate({ token: code, timestamp: at, window: 1 });
      return delta === null ? null : Math.floor(at / 30_000) + delta;
    } finally { plaintext.fill(0); }
  };
  const recoveryCodes = (id: number) => {
    const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
    db.prepare('DELETE FROM auth_recovery_codes WHERE user_id = ?').run(id);
    for (const code of codes) db.prepare('INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(id, hash(code));
    return codes;
  };
  const verify = (id: number, code: unknown, recovery: boolean, session?: { id: string; store: ReturnType<typeof createSessionStore> }): boolean => {
    if (session) {
      const current = session.store.getCurrent(session.id);
      if (!current || current.userId !== id) throw new AppError('Please sign in again', { code: 'AUTH_TOKEN_INVALID', statusCode: 401 });
    } else checkThrottle(id);
    let attemptsRemaining: number | undefined;
    const valid = db.transaction(() => {
      const stored = row(id);
      if (!stored?.enabled || !stored.seed_sealed) return false;
      let accepted = false;
      if (recovery) {
        if (typeof code === 'string' && /^[a-f0-9]{32}$/i.test(code)) {
          accepted = db.prepare('UPDATE auth_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
            .run(now(), id, hash(code.toLowerCase())).changes === 1;
        }
      } else {
        const matched = step(id, stored.seed_sealed, 'seed_sealed', code);
        if (matched !== null) accepted = db.prepare(`UPDATE auth_totp SET last_used_step = ?
          WHERE user_id = ? AND enabled = 1 AND generation = ? AND last_used_step < ?`)
          .run(matched, id, stored.generation, matched).changes === 1;
      }
      if (session) {
        if (accepted) session.store.resetMfaAttempts(session.id);
        else attemptsRemaining = session.store.failMfaAttempt(session.id, id);
      } else if (accepted) db.prepare('DELETE FROM auth_throttle WHERE user_id = ?').run(id);
      else failure(id);
      return accepted;
    })();
    if (!valid) {
      if (attemptsRemaining !== undefined) throw new AppError(
        attemptsRemaining === 0 ? 'Session ended after too many incorrect authenticator codes' : 'Invalid or already used verification code',
        { code: attemptsRemaining === 0 ? 'MFA_SESSION_REVOKED' : 'MFA_CODE_INVALID', statusCode: attemptsRemaining === 0 ? 401 : 403, details: { attemptsRemaining } },
      );
      throw invalid();
    }
    return true;
  };
  return {
    enabled,
    beginEnrollment(id: number, username: string, sessionId: string) {
      const secret = new Secret({ size: 20 });
      const expiresAt = now() + MFA_FRESH_MS;
      const sealed = getBox().seal(secret.base32, aad(id, 'pending_sealed'));
      db.prepare(`INSERT INTO auth_totp (user_id, pending_sealed, pending_expires_at, pending_session_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET pending_sealed=excluded.pending_sealed, pending_expires_at=excluded.pending_expires_at, pending_session_id=excluded.pending_session_id`)
        .run(id, sealed, expiresAt, sessionId);
      return { secret: secret.base32, uri: new TOTP({ issuer: 'RemoteCLI', label: username, secret, digits: 6, period: 30 }).toString(), expiresAt };
    },
    activate(id: number, sessionId: string, code: unknown) {
      checkThrottle(id);
      const result = db.transaction(() => {
        const stored = row(id);
        if (!stored?.pending_sealed || stored.pending_session_id !== sessionId || (stored.pending_expires_at ?? 0) <= now()) return null;
        const matched = step(id, stored.pending_sealed, 'pending_sealed', code);
        if (matched === null) { failure(id); return null; }
        const plain = getBox().open(stored.pending_sealed, aad(id, 'pending_sealed'));
        try {
          const sealed = getBox().seal(plain, aad(id, 'seed_sealed'));
          db.prepare(`UPDATE auth_totp SET enabled=1, seed_sealed=?, last_used_step=?, generation=generation+1,
            pending_sealed=NULL, pending_expires_at=NULL, pending_session_id=NULL WHERE user_id=?`)
            .run(sealed, matched, id);
        } finally { plain.fill(0); }
        db.prepare('DELETE FROM auth_throttle WHERE user_id = ?').run(id);
        return { recoveryCodes: recoveryCodes(id) };
      })();
      if (!result) throw invalid();
      return result;
    },
    challenge(id: number) {
      const at = now();
      for (const [key, item] of challenges) if (item.expiresAt <= at) challenges.delete(key);
      // Bound retained challenges without evicting a live authenticated challenge.
      if (challenges.size >= 1000) throw new AppError('Please try signing in later', { code: 'AUTH_RATE_LIMITED', statusCode: 429 });
      const stored = row(id);
      if (!stored?.enabled) return null;
      const challenge = randomBytes(32).toString('base64url');
      const expiresAt = at + MFA_CHALLENGE_MS;
      challenges.set(hash(challenge), { userId: id, generation: stored.generation, expiresAt });
      return { mfaRequired: true as const, challenge, expiresAt };
    },
    completeLogin(challenge: unknown, code: unknown, recovery: boolean) {
      const key = typeof challenge === 'string' && challenge.length === 43 ? hash(challenge) : '';
      const pending = challenges.get(key);
      if (!pending || pending.expiresAt <= now() || row(pending.userId)?.generation !== pending.generation || !enabled(pending.userId)) {
        challenges.delete(key);
        throw new AppError('Sign in again to request a new challenge', { code: 'MFA_CHALLENGE_INVALID', statusCode: 401 });
      }
      verify(pending.userId, code, recovery);
      challenges.delete(key);
      return { userId: pending.userId, verifiedAt: recovery ? 0 : now() };
    },
    invalidateChallenges(id: number) {
      db.prepare('UPDATE auth_totp SET generation=generation+1, pending_sealed=NULL, pending_expires_at=NULL, pending_session_id=NULL WHERE user_id=?').run(id);
      for (const [key, pending] of challenges) if (pending.userId === id) challenges.delete(key);
    },
    verifyTotp(id: number, code: unknown) { verify(id, code, false); },
    verifySessionTotp(id: number, sessionId: string, code: unknown, sessions: ReturnType<typeof createSessionStore>) {
      if (!enabled(id)) throw new AppError('Enable TOTP first', { code: 'MFA_DISABLED', statusCode: 409 });
      verify(id, code, false, { id: sessionId, store: sessions });
    },
    regenerateRecovery(id: number) { return db.transaction(() => recoveryCodes(id))(); },
    disable(id: number) {
      db.transaction(() => {
        db.prepare(`UPDATE auth_totp SET enabled=0, seed_sealed=NULL, pending_sealed=NULL, pending_expires_at=NULL,
          pending_session_id=NULL, last_used_step=-1, generation=generation+1 WHERE user_id=?`).run(id);
        db.prepare('DELETE FROM auth_recovery_codes WHERE user_id=?').run(id);
        db.prepare('DELETE FROM auth_throttle WHERE user_id=?').run(id);
      })();
      for (const [key, pending] of challenges) if (pending.userId === id) challenges.delete(key);
    },
  };
}
