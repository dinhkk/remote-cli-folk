import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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


test('TH-01/02/03/06/07: session failures revoke only that session; success resets and replay stays global', t => {
  const f = fixture(t); const e = f.activate();
  const b = f.sessions.create(1, 'second', f.now()).session;
  const verify = (id: string, value: string) => f.store.verifySessionTotp(1, id, value, f.sessions);
  for (let n = 1; n <= 3; n++) assert.throws(() => verify(f.session.id, 'bad'), error => {
    assert.equal((error as {details:{attemptsRemaining:number}}).details.attemptsRemaining, 5-n); return true;
  });
  f.advance(30_000); verify(f.session.id, code(e.secret, f.now()));
  assert.equal(f.db.prepare('SELECT 1 FROM auth_session_mfa_attempts').get(), undefined);
  assert.throws(() => verify(b.id, code(e.secret, f.now())), error => (error as {code:string}).code === 'MFA_CODE_INVALID');
  for (let n = 0; n < 5; n++) assert.throws(() => verify(f.session.id, 'bad'));
  assert.equal(f.sessions.getCurrent(f.session.id), null);
  assert.ok(f.sessions.getActive(b.id));
  assert.equal(f.db.prepare('SELECT 1 FROM auth_throttle').get(), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM auth_session_mfa_attempts WHERE session_id=?').get(f.session.id), undefined);
  assert.equal(f.db.prepare<{n:number}>("SELECT count(*) n FROM auth_events WHERE session_id=? AND kind='mfa-attempts-exceeded'").get(f.session.id)?.n,1);
  f.advance(30_000); verify(b.id, code(e.secret, f.now()));
  f.advance(30_000); assert.equal(f.store.completeLogin(f.store.challenge(1)!.challenge, code(e.secret, f.now()), false).userId,1);
});

test('TH-04/05: account login throttle remains, but cannot block verified sessions', t => {
  const f=fixture(t); const e=f.activate();
  const challenge=f.store.challenge(1)!.challenge;
  for(let n=0;n<5;n++) assert.throws(()=>f.store.completeLogin(challenge,'bad',false));
  const blocked=f.db.prepare('SELECT * FROM auth_throttle').get();
  f.advance(30_000);
  f.store.verifySessionTotp(1,f.session.id,code(e.secret,f.now()),f.sessions);
  assert.deepEqual(f.db.prepare('SELECT * FROM auth_throttle').get(),blocked);
  assert.throws(()=>f.store.completeLogin(challenge,code(e.secret,f.now()),false), error=>(error as {code:string}).code==='AUTH_RATE_LIMITED');
});

test('TH-03/09: additive migration preserves epoch/sessions and failures survive store recreation', t => {
  const f=fixture(t);f.activate();
  const before=f.db.prepare('SELECT * FROM auth_sessions').all();
  const epoch=f.db.prepare('SELECT * FROM app_config').all();
  for(let n=0;n<4;n++) assert.throws(()=>f.store.verifySessionTotp(1,f.session.id,'bad',f.sessions));
  migrateAuthSessions(f.db,f.now());
  assert.deepEqual(f.db.prepare('SELECT * FROM auth_sessions').all(),before);
  assert.deepEqual(f.db.prepare('SELECT * FROM app_config').all(),epoch);
  const sessions=createSessionStore(f.db,f.now),store=createTotpStore(f.db,()=>f.box,f.now);
  assert.throws(()=>store.verifySessionTotp(1,f.session.id,'bad',sessions), error=>(error as {code:string}).code==='MFA_SESSION_REVOKED');
  assert.equal(sessions.getCurrent(f.session.id),null);
});

test('TH-03: explicit revocation, revoke-all and expiration remove session attempt rows', t => {
  const f=fixture(t); f.activate();
  for(const action of ['revoke','all','expire']) {
    const session=f.sessions.create(1,'browser',f.now()).session;
    assert.throws(()=>f.store.verifySessionTotp(1,session.id,'bad',f.sessions));
    if(action==='revoke') f.sessions.revoke(session.id,1);
    else if(action==='all') f.sessions.revokeAll(1);
    else { f.advance(8*86400_000); f.sessions.expire(); }
    assert.equal(f.db.prepare('SELECT 1 FROM auth_session_mfa_attempts WHERE session_id=?').get(session.id),undefined);
  }
});

test('TH-03: attempt counter survives closing and reopening the database', () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),'session-attempts-'));const file=path.join(dir,'auth.db');
 let db=new Database(file);
 try {
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1); CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);");
  const now=()=>1_700_000_000_000;const box=createSecretBox(randomBytes(32));
  migrateAuthSessions(db,now());migrateTotp(db,now());
  let sessions=createSessionStore(db,now),mfa=createTotpStore(db,()=>box,now);
  const session=sessions.create(1).session;const enrollment=mfa.beginEnrollment(1,'synthetic',session.id);
  mfa.activate(1,session.id,code(enrollment.secret,now()));sessions.markMfa(session.id,now());
  for(let n=0;n<4;n++)assert.throws(()=>mfa.verifySessionTotp(1,session.id,'bad',sessions));
  db.close();db=new Database(file);migrateAuthSessions(db,now());
  sessions=createSessionStore(db,now);mfa=createTotpStore(db,()=>box,now);
  assert.throws(()=>mfa.verifySessionTotp(1,session.id,'bad',sessions),error=>(error as {code:string}).code==='MFA_SESSION_REVOKED');
  assert.equal(sessions.getCurrent(session.id),null);
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
