import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoginRateLimiter } from '../services/login-rate-limit.service.js';

const MINUTE = 60_000;

function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function fail(limiter: ReturnType<typeof createLoginRateLimiter>, ip: string, username: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    limiter.recordFailure(ip, username);
  }
}

test('four failures for one (ip, username) do not lock; the fifth does, for 15 minutes', () => {
  const clock = createClock();
  const limiter = createLoginRateLimiter({ now: clock.now });

  fail(limiter, '10.0.0.1', 'alice', 4);
  assert.deepEqual(limiter.check('10.0.0.1', 'alice'), { allowed: true });

  limiter.recordFailure('10.0.0.1', 'alice');
  assert.deepEqual(limiter.check('10.0.0.1', 'alice'), { allowed: false, retryAfterSeconds: 900 });
});

test('Retry-After counts down and rounds up', () => {
  const clock = createClock();
  const limiter = createLoginRateLimiter({ now: clock.now });
  fail(limiter, '10.0.0.1', 'alice', 5);

  clock.advance(60_500);
  assert.deepEqual(limiter.check('10.0.0.1', 'alice'), { allowed: false, retryAfterSeconds: 840 });
});

test('the lock lifts after 15 minutes', () => {
  const clock = createClock();
  const limiter = createLoginRateLimiter({ now: clock.now });
  fail(limiter, '10.0.0.1', 'alice', 5);

  clock.advance(15 * MINUTE - 1);
  assert.equal(limiter.check('10.0.0.1', 'alice').allowed, false);
  clock.advance(2);
  assert.deepEqual(limiter.check('10.0.0.1', 'alice'), { allowed: true });
});

test('failures older than the 10 minute window do not count towards a lock', () => {
  const clock = createClock();
  const limiter = createLoginRateLimiter({ now: clock.now });

  fail(limiter, '10.0.0.1', 'alice', 4);
  clock.advance(11 * MINUTE);
  limiter.recordFailure('10.0.0.1', 'alice');

  assert.deepEqual(limiter.check('10.0.0.1', 'alice'), { allowed: true });
});

test('a successful login resets the counter of that pair', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });

  fail(limiter, '10.0.0.1', 'alice', 4);
  limiter.recordSuccess('10.0.0.1', 'alice');
  fail(limiter, '10.0.0.1', 'alice', 4);

  assert.deepEqual(limiter.check('10.0.0.1', 'alice'), { allowed: true });
});

test('the lock is per pair: another IP or another username is not locked', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });
  fail(limiter, '10.0.0.1', 'alice', 5);

  assert.equal(limiter.check('10.0.0.1', 'alice').allowed, false);
  assert.equal(limiter.check('10.0.0.2', 'alice').allowed, true);
  assert.equal(limiter.check('10.0.0.1', 'bob').allowed, true);
});

test('username matching ignores case and surrounding whitespace', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });
  limiter.recordFailure('10.0.0.1', 'Alice');
  limiter.recordFailure('10.0.0.1', ' alice ');
  limiter.recordFailure('10.0.0.1', 'ALICE');
  limiter.recordFailure('10.0.0.1', 'alice');
  limiter.recordFailure('10.0.0.1', 'aLiCe');

  assert.equal(limiter.check('10.0.0.1', 'alice').allowed, false);
});

test('20 failures from one IP across different usernames lock that IP only', () => {
  const clock = createClock();
  const limiter = createLoginRateLimiter({ now: clock.now });

  for (let i = 0; i < 19; i += 1) {
    limiter.recordFailure('10.0.0.1', `user-${i}`);
  }
  assert.equal(limiter.check('10.0.0.1', 'fresh-user').allowed, true);

  limiter.recordFailure('10.0.0.1', 'user-19');
  assert.deepEqual(limiter.check('10.0.0.1', 'fresh-user'), { allowed: false, retryAfterSeconds: 900 });
  assert.equal(limiter.check('10.0.0.2', 'fresh-user').allowed, true);

  clock.advance(15 * MINUTE + 1);
  assert.equal(limiter.check('10.0.0.1', 'fresh-user').allowed, true);
});

test('a success clears only the pair, never the per-IP failure count', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });

  for (let i = 0; i < 15; i += 1) {
    limiter.recordFailure('10.0.0.1', `user-${i}`);
  }
  limiter.recordSuccess('10.0.0.1', 'user-0');
  for (let i = 15; i < 19; i += 1) {
    limiter.recordFailure('10.0.0.1', `user-${i}`);
  }
  assert.equal(limiter.check('10.0.0.1', 'someone-new').allowed, true, '19 failures: not yet');

  limiter.recordFailure('10.0.0.1', 'user-19');
  assert.equal(limiter.check('10.0.0.1', 'someone-new').allowed, false, '20th failure locks the IP');
});

test('attempt() reserves a slot up front: five attempts are admitted, the sixth is refused even if none has finished', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });

  const results = Array.from({ length: 8 }, () => limiter.attempt('10.0.0.1', 'alice'));

  assert.deepEqual(results.map((result) => result.allowed), [true, true, true, true, true, false, false, false]);
  const refused = results[5];
  assert.equal(refused.allowed, false);
  if (!refused.allowed) {
    assert.equal(refused.retryAfterSeconds, 900);
  }
});

test('attempt().succeeded() refunds the per-IP slot and clears the pair', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });

  // 19 IP-wide failures from other usernames, then one successful login by alice.
  for (let i = 0; i < 19; i += 1) {
    limiter.attempt('10.0.0.1', `user-${i}`);
  }
  const alice = limiter.attempt('10.0.0.1', 'alice');
  assert.equal(alice.allowed, true);
  if (alice.allowed) {
    alice.succeeded();
  }

  // The refund leaves room for exactly one more failure before the IP locks.
  assert.equal(limiter.attempt('10.0.0.1', 'other').allowed, true);
  assert.equal(limiter.attempt('10.0.0.1', 'another').allowed, false);
});

test('IPv6 clients are keyed by /64: rotating the host part does not escape the lock', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });
  for (let i = 0; i < 5; i += 1) {
    limiter.attempt(`2001:db8:abcd:12::${i + 1}`, 'alice');
  }

  assert.equal(limiter.check('2001:db8:abcd:12:ffff:ffff:ffff:ffff', 'alice').allowed, false, 'same /64');
  assert.equal(limiter.check('2001:0db8:abcd:0012:0:0:0:99', 'alice').allowed, false, 'same /64, uncompressed');
  assert.equal(limiter.check('2001:db8:abcd:13::1', 'alice').allowed, true, 'different /64');
});

test('an IPv4-mapped IPv6 address is the same client as the plain IPv4 address', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });
  for (let i = 0; i < 5; i += 1) {
    limiter.attempt('::ffff:203.0.113.5', 'alice');
  }

  assert.equal(limiter.check('203.0.113.5', 'alice').allowed, false);
});

test('very long or odd client strings cannot bloat keys', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });
  const huge = 'x'.repeat(5_000);
  for (let i = 0; i < 5; i += 1) {
    limiter.attempt(huge, 'alice');
  }

  assert.equal(limiter.check(huge, 'alice').allowed, false);
  assert.equal(limiter.check('unknown', 'alice').allowed, true);
});

test('memory is capped: 20000 random usernames never exceed 10000 entries', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });

  for (let i = 0; i < 20_000; i += 1) {
    limiter.recordFailure(`198.51.${Math.floor(i / 250)}.${i % 250}`, `random-${i}`);
    assert.ok(limiter.size() <= 10_000, `size ${limiter.size()} after ${i + 1} failures`);
  }
});

test('a locked entry survives a flood of unrelated single failures', () => {
  const limiter = createLoginRateLimiter({ now: createClock().now });
  fail(limiter, '10.0.0.1', 'alice', 5);

  for (let i = 0; i < 20_000; i += 1) {
    limiter.recordFailure(`198.51.${Math.floor(i / 250)}.${i % 250}`, `random-${i}`);
  }

  assert.equal(limiter.check('10.0.0.1', 'alice').allowed, false);
});
