import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';

import { Secret, TOTP } from 'otpauth';

import { Database } from '../../database/index.js';
import { createSecretBox } from '../../remote/index.js';
import { migrateAuthSessions, createSessionStore } from '../services/session-store.service.js';
import { createTotpStore, migrateTotp, MFA_FRESH_MS, MFA_CHALLENGE_MS } from '../services/totp-store.service.js';

const code = (secret: string, timestamp: number) => new TOTP({ secret, digits: 6, period: 30 }).generate({ timestamp });
function fixture(t: { after(cb: () => void): void }) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);");
  let at = 1_700_000_000_000;
  migrateAuthSessions(db, at); migrateTotp(db, at);
  const box = createSecretBox(randomBytes(32));
  const store = createTotpStore(db, () => box, () => at);
  const sessions = createSessionStore(db, () => at);
  const session = sessions.create(1).session;
  const enroll = () => store.beginEnrollment(1, 'synthetic-owner', session.id);
  const activate = () => { const e = enroll(); const a = store.activate(1, session.id, code(e.secret, at)); sessions.markMfa(session.id, at); return { ...e, ...a }; };
  return { db, store, sessions, session, enroll, activate, box, now: () => at, advance: (ms: number) => { at += ms; } };
}

test('T-01/Q-01: all eighteen RFC 6238 Appendix B vectors', () => {
  const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
  const vectors = {
    SHA1: ['94287082','07081804','14050471','89005924','69279037','65353130'],
    SHA256: ['46119246','68084774','67062674','91819424','90698825','77737706'],
    SHA512: ['90693936','25091201','99943326','93441116','38618901','47863826'],
  };
  for (const [algorithm, expected] of Object.entries(vectors)) {
    const length = algorithm === 'SHA1' ? 20 : algorithm === 'SHA256' ? 32 : 64;
    const secret = Secret.fromUTF8('1234567890'.repeat(7).slice(0, length));
    const totp = new TOTP({ secret, algorithm, digits: 8, period: 30 });
    times.forEach((time, i) => assert.ok(totp.generate({ timestamp: time * 1000 }) === expected[i], `${algorithm} vector ${i}`));
  }
});

test('T-00/T-02/T-05/T-06: pending enrollment is sealed, session-bound and only activated by a valid code', (t) => {
  const f = fixture(t); assert.equal(f.store.enabled(1), false);
  const e = f.enroll();
  assert.equal(f.store.enabled(1), false);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM auth_totp').all()).includes(e.secret));
  assert.throws(() => f.store.activate(1, 'another-session', code(e.secret, f.now())));
  const activated = f.store.activate(1, f.session.id, code(e.secret, f.now()));
  assert.equal(f.store.enabled(1), true); assert.equal(activated.recoveryCodes.length, 10);
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM auth_recovery_codes').all());
  assert.ok(activated.recoveryCodes.every(c => !stored.includes(c)));
  assert.throws(() => f.store.activate(1, f.session.id, code(e.secret, f.now())));
  assert.equal(f.sessions.getActive(f.session.id), null, 'password-only sessions do not become MFA sessions');
});

test('T-05: pending enrollment expires exactly at ten minutes', (t) => {
  const f = fixture(t); const e = f.enroll(); f.advance(MFA_FRESH_MS);
  assert.throws(() => f.store.activate(1, f.session.id, code(e.secret, f.now())));
  assert.equal(f.store.enabled(1), false);
});

test('T-01/T-03: six digits, adjacent steps only and monotonic conditional step consumption', (t) => {
  const f = fixture(t); const e = f.activate();
  assert.throws(() => f.store.verifyTotp(1, code(e.secret, f.now())));
  f.advance(90_000);
  f.store.verifyTotp(1, code(e.secret, f.now() - 30_000));
  f.store.verifyTotp(1, code(e.secret, f.now()));
  f.store.verifyTotp(1, code(e.secret, f.now() + 30_000));
  assert.throws(() => f.store.verifyTotp(1, code(e.secret, f.now() + 60_000)));
  assert.throws(() => f.store.verifyTotp(1, code(e.secret, f.now() - 60_000)));
  assert.throws(() => f.store.verifyTotp(1, '1234567'));
});

test('T-04: account throttling persists after restart, doubles from five minutes and caps at 24 hours', (t) => {
  const f = fixture(t); f.activate();
  for (let level = 0; level < 11; level++) {
    for (let i = 0; i < 5; i++) assert.throws(() => f.store.verifyTotp(1, 'bad'));
    const duration = Math.min(300_000 * 2 ** level, 86_400_000);
    const restarted = createTotpStore(f.db, () => f.box, f.now);
    assert.throws(() => restarted.verifyTotp(1, 'bad'), (e: unknown) => (e as { code: string }).code === 'AUTH_RATE_LIMITED');
    const blocked = f.db.prepare<{ blocked_until: number }>('SELECT blocked_until FROM auth_throttle WHERE user_id=1').get()!;
    assert.equal(blocked.blocked_until - f.now(), duration);
    assert.equal(f.db.prepare('SELECT 1 FROM auth_throttle WHERE user_id=2').get(), undefined);
    f.advance(duration);
  }
});

test('A-01/A-02/K-02: challenges are not sessions, expire at five minutes and are single-use', (t) => {
  const f = fixture(t); const e = f.activate(); f.advance(30_000);
  const challenge = f.store.challenge(1)!;
  assert.equal(f.sessions.authenticate(challenge.challenge), null);
  f.store.completeLogin(challenge.challenge, code(e.secret, f.now()), false);
  assert.throws(() => f.store.completeLogin(challenge.challenge, code(e.secret, f.now()), false));
  const expired = f.store.challenge(1)!; f.advance(MFA_CHALLENGE_MS);
  assert.throws(() => f.store.completeLogin(expired.challenge, code(e.secret, f.now()), false));
});

test('T-06/K-09: recovery consumption is one-time and does not count as a fresh authenticator code', (t) => {
  const f = fixture(t); const e = f.activate();
  const challenge = f.store.challenge(1)!;
  const result = f.store.completeLogin(challenge.challenge, e.recoveryCodes[0], true);
  assert.equal(result.verifiedAt, 0);
  const second = f.store.challenge(1)!;
  assert.throws(() => f.store.completeLogin(second.challenge, e.recoveryCodes[0], true));
  const newCodes = f.store.regenerateRecovery(1);
  assert.equal(newCodes.length, 10);
  assert.throws(() => f.store.completeLogin(second.challenge, e.recoveryCodes[1], true));
});

test('T-10: disable clears pending/active material and invalidates challenges', (t) => {
  const f = fixture(t); const e = f.activate(); const c = f.store.challenge(1)!;
  f.store.disable(1);
  assert.equal(f.store.enabled(1), false);
  assert.equal(f.db.prepare('SELECT 1 FROM auth_recovery_codes').get(), undefined);
  assert.throws(() => f.store.completeLogin(c.challenge, e.recoveryCodes[0], true));
});
