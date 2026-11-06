import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteBridgeViolation, RemoteRelayLink } from '@/shared/types.js';

import { DEFAULT_HOST_BRIDGE_LIMITS } from '../../bridge/bridge-limits.js';
import { createHostBridge } from '../../bridge/host-bridge.js';
import { createViolationRateLimiter } from '../../bridge/violation-rate-limiter.js';
import { createStreamStub } from '../support/bridge-test-harness.js';

/** A clock the test moves by hand (milliseconds). */
const manualNow = (): { now: () => number; advance: (ms: number) => void } => {
  let time = 1_000;
  return { now: () => time, advance: (ms) => void (time += ms) };
};

// ---------------------------------------------------------------------------
// The token bucket itself
// ---------------------------------------------------------------------------

test('a full bucket allows the burst, then refuses; refused calls are counted', () => {
  const clock = manualNow();
  const limiter = createViolationRateLimiter({ burst: 3, perSecond: 1, now: clock.now });
  assert.deepEqual([limiter.tryConsume(), limiter.tryConsume(), limiter.tryConsume(), limiter.tryConsume(), limiter.tryConsume()], [true, true, true, false, false]);
  assert.equal(limiter.suppressed, 2);
});

test('the bucket refills at the configured rate and never beyond the burst', () => {
  const clock = manualNow();
  const limiter = createViolationRateLimiter({ burst: 2, perSecond: 2, now: clock.now });
  assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), false);
  clock.advance(499); // 0.998 of a token
  assert.equal(limiter.tryConsume(), false);
  clock.advance(1); // exactly one token
  assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), false);
  clock.advance(60 * 60 * 1000); // an hour of silence refills only the burst
  assert.deepEqual([limiter.tryConsume(), limiter.tryConsume(), limiter.tryConsume()], [true, true, false]);
});

test('a clock that goes backwards neither refills nor breaks the bucket', () => {
  const clock = manualNow();
  const limiter = createViolationRateLimiter({ burst: 1, perSecond: 1000, now: clock.now });
  assert.equal(limiter.tryConsume(), true);
  clock.advance(-5_000);
  assert.equal(limiter.tryConsume(), false);
  clock.advance(5_000 + 1_000);
  assert.equal(limiter.tryConsume(), true);
});

test('a rate of 0 is a fixed allowance that never refills', () => {
  const clock = manualNow();
  const limiter = createViolationRateLimiter({ burst: 1, perSecond: 0, now: clock.now });
  assert.equal(limiter.tryConsume(), true);
  clock.advance(10 * 60 * 60 * 1000);
  assert.equal(limiter.tryConsume(), false);
});

test('invalid configuration is refused instead of silently disabling the limit', () => {
  for (const burst of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createViolationRateLimiter({ burst, perSecond: 1 }), /burst/, String(burst));
  }
  for (const perSecond of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createViolationRateLimiter({ burst: 5, perSecond }), /perSecond/, String(perSecond));
  }
});

test('the defaults are the documented ones: 20 reports of burst, 1 per second afterwards', () => {
  assert.equal(DEFAULT_HOST_BRIDGE_LIMITS.violationBurst, 20);
  assert.equal(DEFAULT_HOST_BRIDGE_LIMITS.violationsPerSecond, 1);
  const limiter = createViolationRateLimiter({ burst: DEFAULT_HOST_BRIDGE_LIMITS.violationBurst, perSecond: DEFAULT_HOST_BRIDGE_LIMITS.violationsPerSecond });
  let allowed = 0;
  for (let i = 0; i < 1000; i += 1) if (limiter.tryConsume()) allowed += 1;
  assert.ok(allowed >= 20 && allowed <= 21, `${allowed} reports let through a flood of 1000`);
});

// ---------------------------------------------------------------------------
// The bridge uses it before onViolation
// ---------------------------------------------------------------------------

const forbiddenRequest = { kind: 'http', meta: { method: 'TRACE', path: '/api/projects', headers: {} } } as const;

test('a flood of refused requests reaches onViolation only up to the burst; every request is still refused', () => {
  const clock = manualNow();
  const reported: RemoteBridgeViolation[] = [];
  const counted: RemoteBridgeViolation[] = [];
  const bridge = createHostBridge({
    port: 3999,
    env: {},
    now: clock.now,
    limits: { violationBurst: 5, violationsPerSecond: 1 },
    onViolation: (violation) => reported.push(violation),
    onViolationSuppressed: (violation) => counted.push(violation),
  });
  const stubs = Array.from({ length: 100 }, () => createStreamStub('http'));
  for (const stub of stubs) bridge.handleStream(stub, forbiddenRequest);

  assert.equal(reported.length, 5, 'the audit callback sees the burst only');
  assert.equal(counted.length, 95, 'the rest goes to the cheap counter hook');
  assert.equal(bridge.suppressedViolations, 95);
  assert.ok(stubs.every((stub) => stub.failure?.code === 'REMOTE_FORBIDDEN'), 'the refusal itself is never rate limited');

  clock.advance(3_000); // three tokens back
  for (let i = 0; i < 10; i += 1) bridge.handleStream(createStreamStub('http'), forbiddenRequest);
  assert.equal(reported.length, 8);
  assert.equal(bridge.suppressedViolations, 102);
});

test('every kind of violation shares the bucket (HTTP, headers, body length, WebSocket open and message)', () => {
  const clock = manualNow();
  const reported: RemoteBridgeViolation[] = [];
  const bridge = createHostBridge({ port: 3999, env: {}, now: clock.now, limits: { violationBurst: 2, violationsPerSecond: 0 }, onViolation: (violation) => reported.push(violation) });
  bridge.handleStream(createStreamStub('http'), { kind: 'http', meta: { method: 'GET', path: '/api/auth/user', headers: {} } });
  bridge.handleStream(createStreamStub('http'), { kind: 'http', meta: { method: 'GET', path: '/api/projects', headers: { accept: ['a', 'b'] } } });
  bridge.handleStream(createStreamStub('ws'), { kind: 'ws', meta: { path: '/api/projects' } });
  bridge.handleStream(createStreamStub('http'), { kind: 'http', meta: { method: 'POST', path: '/api/projects', headers: { 'content-length': '9999999999' } } });
  assert.deepEqual(reported.map((violation) => violation.kind), ['http-request', 'request-headers']);
  assert.equal(bridge.suppressedViolations, 2);
});

test('a throwing onViolation or onViolationSuppressed never takes the bridge down', () => {
  const bridge = createHostBridge({
    port: 3999,
    env: {},
    limits: { violationBurst: 1, violationsPerSecond: 0 },
    onViolation: () => {
      throw new Error('audit store down');
    },
    onViolationSuppressed: () => {
      throw new Error('counter down');
    },
  });
  for (let i = 0; i < 3; i += 1) {
    const stub = createStreamStub('http');
    bridge.handleStream(stub, forbiddenRequest);
    assert.equal(stub.failure?.code, 'REMOTE_FORBIDDEN');
  }
  assert.equal(bridge.suppressedViolations, 2);
});

test('each attached link has its own bucket: one noisy Controller cannot silence the audit of another', () => {
  const clock = manualNow();
  const reported: RemoteBridgeViolation[] = [];
  const bridge = createHostBridge({ port: 3999, env: {}, now: clock.now, limits: { violationBurst: 2, violationsPerSecond: 0 }, onViolation: (violation) => reported.push(violation) });
  const handlers: Array<Parameters<RemoteRelayLink['onStream']>[0]> = [];
  const attachLink = (): void => {
    bridge.attach({ sessionActive: true, onStream: (handler) => (handlers.push(handler), () => undefined) });
  };
  attachLink();
  attachLink();
  const [noisy, quiet] = handlers;

  for (let i = 0; i < 10; i += 1) noisy(createStreamStub('http'), forbiddenRequest);
  assert.equal(reported.length, 2);
  quiet(createStreamStub('http'), forbiddenRequest);
  assert.equal(reported.length, 3, 'the second link still has a full bucket');
});
