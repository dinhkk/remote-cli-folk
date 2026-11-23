import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Database } from '../../database/index.js';

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MIGRATION_ID = 'auth-sessions-v1';

export type AuthSession = {
  id: string;
  userId: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  lockedAt: number | null;
  revokedAt: number | null;
  mfaVerifiedAt: number | null;
  browser: string;
};

type SessionRow = {
  id: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  locked_at: number | null;
  revoked_at: number | null;
  mfa_verified_at: number | null;
  browser: string;
};

type EndReason = 'logout' | 'revoked' | 'expired';
type SessionEnd = { sessionId: string; reason: EndReason };

const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const rowToSession = (row: SessionRow): AuthSession => ({
  id: row.id,
  userId: row.user_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  lockedAt: row.locked_at,
  revokedAt: row.revoked_at,
  mfaVerifiedAt: row.mfa_verified_at,
  browser: row.browser,
});

/** Store only a bounded browser label, never arbitrary request-header contents. */
export function browserFamily(userAgent = ''): string {
  if (/Edg\//i.test(userAgent)) return 'Edge';
  if (/OPR\//i.test(userAgent)) return 'Opera';
  if (/Firefox\//i.test(userAgent)) return 'Firefox';
  if (/Chrome\//i.test(userAgent)) return 'Chrome';
  if (/Safari\//i.test(userAgent)) return 'Safari';
  return 'Other';
}

/** Additive schema change. The migration marker and legacy tab-token epoch move atomically. */
export function migrateAuthSessions(db: Database, now = Date.now()): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        locked_at INTEGER,
        revoked_at INTEGER,
        mfa_verified_at INTEGER,
        browser TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
      CREATE TABLE IF NOT EXISTS auth_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    if (db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(MIGRATION_ID)) return;
    const stored = db.prepare<{ value: string }>('SELECT value FROM app_config WHERE key = ?')
      .get('auth.token_epoch');
    const epoch = Number.parseInt(stored?.value ?? '0', 10);
    const next = Number.isSafeInteger(epoch) && epoch >= 0 ? epoch + 1 : 1;
    db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('auth.token_epoch', String(next));
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(MIGRATION_ID, now);
  })();
}

/** Persistence and revocation, independent of HTTP, cookies, or a running server. */
export function createSessionStore(db: Database, now: () => number = () => Date.now()) {
  const ended = new Set<(event: SessionEnd) => void>();
  const activity = new Map<string, number>();
  const event = (session: AuthSession, kind: string, at: number) => {
    db.prepare('INSERT INTO auth_events (user_id, session_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(session.userId, session.id, kind, at);
  };
  const notify = (sessionId: string, reason: EndReason) => {
    activity.delete(sessionId);
    for (const listener of [...ended]) {
      try { listener({ sessionId, reason }); } catch {
        // One transport failing to close must not prevent revocation of the others.
      }
    }
  };
  const read = (id: string): AuthSession | null => {
    const row = db.prepare<SessionRow>('SELECT * FROM auth_sessions WHERE id = ?').get(id);
    return row ? rowToSession(row) : null;
  };
  const revoke = (id: string, userId: number, reason: EndReason = 'revoked'): boolean => {
    const changed = db.transaction(() => {
      const session = read(id);
      if (!session || session.userId !== userId || session.revokedAt !== null) return false;
      const at = now();
      const result = db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(at, id);
      if (result.changes !== 1) return false;
      event(session, reason, at);
      return true;
    })();
    if (changed) notify(id, reason);
    return changed;
  };
  const getActive = (id: string): AuthSession | null => {
    const session = read(id);
    if (!session || session.revokedAt !== null) return null;
    if (session.expiresAt <= now()) {
      revoke(id, session.userId, 'expired');
      return null;
    }
    return session.lockedAt === null ? session : null;
  };

  return {
    create(userId: number, userAgent = ''): { secret: string; session: AuthSession } {
      const at = now();
      const secret = randomBytes(32).toString('base64url');
      const session: AuthSession = {
        id: randomUUID(), userId, createdAt: at, lastSeenAt: at,
        expiresAt: at + SESSION_MAX_AGE_MS, lockedAt: null, revokedAt: null,
        mfaVerifiedAt: null, browser: browserFamily(userAgent),
      };
      db.transaction(() => {
        db.prepare(`INSERT INTO auth_sessions
          (id, user_id, secret_hash, created_at, last_seen_at, expires_at, browser)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(session.id, userId, digest(secret), at, at, session.expiresAt, session.browser);
        event(session, 'login', at);
      })();
      return { secret, session };
    },
    authenticate(secret: string): AuthSession | null {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
      const row = db.prepare<{ id: string }>('SELECT id FROM auth_sessions WHERE secret_hash = ?').get(digest(secret));
      return row ? getActive(row.id) : null;
    },
    getActive,
    /** A successful HTTP request records activity; transport pings must not call this. */
    touch(id: string, userAgent = ''): AuthSession | null {
      const session = getActive(id);
      if (!session) return null;
      const at = now();
      activity.set(id, at);
      const browser = browserFamily(userAgent);
      if (browser !== session.browser) {
        db.transaction(() => {
          db.prepare('UPDATE auth_sessions SET browser = ? WHERE id = ?').run(browser, id);
          event(session, 'browser-changed', at);
        })();
      }
      if (at - session.lastSeenAt >= ACTIVITY_WRITE_INTERVAL_MS) {
        db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
      }
      return { ...session, lastSeenAt: at, browser };
    },
    lastActivity(id: string): number | null {
      return activity.get(id) ?? read(id)?.lastSeenAt ?? null;
    },
    list(userId: number): AuthSession[] {
      return db.prepare<SessionRow>(`SELECT * FROM auth_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`)
        .all(userId, now()).map(rowToSession);
    },
    revoke,
    revokeAll(userId: number): number {
      const ids = db.transaction(() => {
        const sessions = db.prepare<SessionRow>('SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL')
          .all(userId).map(rowToSession);
        const at = now();
        db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, userId);
        for (const session of sessions) event(session, 'revoked', at);
        return sessions.map((session) => session.id);
      })();
      for (const id of ids) notify(id, 'revoked');
      return ids.length;
    },
    /** Called by the runtime timer, so an idle open stream expires without another request. */
    expire(): number {
      const rows = db.prepare<SessionRow>('SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND expires_at <= ?')
        .all(now());
      for (const row of rows) revoke(row.id, row.user_id, 'expired');
      return rows.length;
    },
    onEnd(listener: (event: SessionEnd) => void): () => void {
      ended.add(listener);
      return () => { ended.delete(listener); };
    },
  };
}
