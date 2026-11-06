/**
 * Per-pairing quota (FR-39, AC-30) on an injectable clock: 64 streams, 8 PTY, 8 WS, 50 new streams per
 * second, release on close, isolation between pairings, and the violation limit that disconnects a pairing
 * (server-caused closes are not violations).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RemoteQuotaReason } from '@/shared/types.js';

import { DEFAULT_QUOTA_LIMITS, createPairingQuota, resolveQuotaLimits, type PairingQuota } from '../../quota/pairing-quota.service.js';
import { createManualClock } from '../support/manual-clock.js';

const arrange = (limits = {}) => {
  const clock = createManualClock(1_000_000);
  const rejected: RemoteQuotaReason[] = [];
  let trips = 0;
  const quota = createPairingQuota({ limits, clock, onReject: (reason) => rejected.push(reason), onViolationLimit: () => (trips += 1) });
  return { clock, quota, rejected, trips: () => trips };
};

/** Opens `count` streams of `kind`, moving the clock 100 ms between them so the per-second rate never interferes. */
const open = (quota: PairingQuota, clock: { advance(ms: number): void }, kind: 'http' | 'ws' | 'pty', count: number) => {
  const releases: Array<() => void> = [];
  for (let index = 0; index < count; index += 1) {
    const result = quota.admit(kind);
    assert.ok(result.ok, `stream ${index + 1} of ${kind} must be admitted`);
    if (result.ok) releases.push(result.release);
    clock.advance(100);
  }
  return releases;
};

describe('pairing quota limits', () => {
  it('defaults are 64 streams, 8 PTY, 8 WS, 50 new streams per second, 20 violations per minute', () => {
    assert.deepEqual(DEFAULT_QUOTA_LIMITS, { maxStreams: 64, maxPty: 8, maxWs: 8, newStreamsPerSecond: 50, violationsPerMinute: 20 });
    assert.deepEqual(resolveQuotaLimits({ maxStreams: 0, maxPty: Number.NaN, maxWs: -3, newStreamsPerSecond: 1.5 }), {
      ...DEFAULT_QUOTA_LIMITS,
      newStreamsPerSecond: 1,
    });
  });

  it('the 65th stream is refused while the 64 older ones keep running', () => {
    const { quota, clock, rejected } = arrange();
    const releases = open(quota, clock, 'http', 64);
    assert.equal(quota.active.streams, 64);
    const refused = quota.admit('http');
    assert.deepEqual(refused, { ok: false, reason: 'streams' });
    assert.deepEqual(rejected, ['streams']);
    assert.equal(quota.active.streams, 64, 'old streams are untouched');
    releases[0]();
    assert.ok(quota.admit('http').ok, 'a freed slot is usable again');
  });

  it('the 9th PTY is refused (the 8 before it are fine) and PTYs also count as streams', () => {
    const { quota, clock, rejected } = arrange();
    open(quota, clock, 'pty', 8);
    assert.deepEqual(quota.admit('pty'), { ok: false, reason: 'pty' });
    assert.deepEqual(rejected, ['pty']);
    assert.ok(quota.admit('ws').ok, 'a chat socket is a different budget');
    assert.deepEqual(quota.active, { streams: 9, pty: 8, ws: 1 });
  });

  it('the 9th WS is refused; plain requests are not limited by the WS budget', () => {
    const { quota, clock } = arrange();
    open(quota, clock, 'ws', 8);
    assert.deepEqual(quota.admit('ws'), { ok: false, reason: 'ws' });
    assert.ok(quota.admit('http').ok);
  });

  it('51 new streams within one second: the 51st is refused, and the allowance returns a second later', () => {
    const { quota, clock, rejected } = arrange();
    const releases: Array<() => void> = [];
    for (let index = 0; index < 50; index += 1) {
      const result = quota.admit('http');
      assert.ok(result.ok, `stream ${index + 1}`);
      if (result.ok) releases.push(result.release);
      clock.advance(10); // 500 ms for all 50
    }
    for (const release of releases) release(); // streams close at once; only the rate remains
    assert.deepEqual(quota.admit('http'), { ok: false, reason: 'rate' });
    assert.deepEqual(rejected, ['rate']);
    clock.advance(600); // the first streams left the one-second window
    assert.ok(quota.admit('http').ok);
  });

  it('release frees the counter once, whatever the number of calls', () => {
    const { quota, clock } = arrange();
    const [releaseTerminal] = open(quota, clock, 'pty', 1);
    assert.deepEqual(quota.active, { streams: 1, pty: 1, ws: 0 });
    releaseTerminal();
    releaseTerminal();
    releaseTerminal();
    assert.deepEqual(quota.active, { streams: 0, pty: 0, ws: 0 });
  });

  it('pairings are isolated: one at its limit does not affect another', () => {
    const first = arrange({ maxWs: 2 });
    const second = arrange({ maxWs: 2 });
    open(first.quota, first.clock, 'ws', 2);
    assert.equal(first.quota.admit('ws').ok, false);
    assert.ok(second.quota.admit('ws').ok);
    assert.deepEqual(second.rejected, []);
  });
});

describe('pairing quota violations', () => {
  it('more than 20 refusals in a minute trips the disconnect once; 20 do not', () => {
    const { quota, clock, trips } = arrange({ maxWs: 1 });
    open(quota, clock, 'ws', 1);
    for (let index = 0; index < 20; index += 1) {
      assert.equal(quota.admit('ws').ok, false);
      clock.advance(500);
    }
    assert.equal(trips(), 0, '20 violations are tolerated');
    assert.equal(quota.admit('ws').ok, false);
    assert.equal(trips(), 1, 'the 21st trips the limit');
    // The window starts over after a trip: it takes another 21 to trip again.
    for (let index = 0; index < 20; index += 1) quota.admit('ws');
    assert.equal(trips(), 1);
    quota.admit('ws');
    assert.equal(trips(), 2);
  });

  it('violations spread over more than a minute never add up', () => {
    const { quota, clock, trips } = arrange({ maxWs: 1 });
    open(quota, clock, 'ws', 1);
    for (let index = 0; index < 60; index += 1) {
      assert.equal(quota.admit('ws').ok, false);
      clock.advance(10_000); // 6 per minute
    }
    assert.equal(trips(), 0);
    assert.ok(quota.recentViolations <= 6);
  });

  it('closes the server caused are not violations: refusals right after them are forgiven, one per close', () => {
    const { quota, clock, trips, rejected } = arrange({ maxWs: 1 });
    open(quota, clock, 'ws', 1);
    for (let index = 0; index < 30; index += 1) quota.noteServerClose(); // credits are capped, not unlimited
    for (let index = 0; index < 100; index += 1) {
      quota.admit('ws');
      clock.advance(100);
    }
    assert.equal(rejected.length, 100, 'every refusal is still reported (audited)');
    // Only the 16 forgiven ones were free: the other 84 count, which is well past 20 in a minute.
    assert.ok(trips() >= 1, 'forgiveness is bounded, so a hostile Controller cannot use it to hold the limit off');

    const calm = arrange({ maxWs: 1 });
    open(calm.quota, calm.clock, 'ws', 1);
    for (let index = 0; index < 15; index += 1) calm.quota.noteServerClose();
    for (let index = 0; index < 15; index += 1) {
      calm.quota.admit('ws');
      calm.clock.advance(100);
    }
    assert.equal(calm.quota.recentViolations, 0, 'a reconnect loop after 15 server closes counts for nothing');
    assert.equal(calm.trips(), 0);
  });

  it('rate refusals (more than 50 new streams in a second) are reported but never count toward the suspension', () => {
    const { quota, clock, rejected, trips } = arrange();
    for (let index = 0; index < 50; index += 1) {
      const result = quota.admit('http');
      assert.ok(result.ok);
      if (result.ok) result.release();
    }
    for (let index = 0; index < 200; index += 1) assert.deepEqual(quota.admit('http'), { ok: false, reason: 'rate' });
    assert.equal(rejected.length, 200, 'every refusal is still audited');
    assert.equal(trips(), 0, 'a burst of honest requests (a cold page load) must not lock the owner out');
    assert.equal(quota.recentViolations, 0);
    clock.advance(1_100);
    assert.ok(quota.admit('http').ok, 'the allowance is back a second later');
  });

  it('a stream refused at the 64-stream boundary because the Controller closed another one a moment earlier is not a violation', () => {
    const { quota, clock, trips } = arrange({ maxStreams: 2 });
    const held = open(quota, clock, 'http', 2);
    for (let round = 0; round < 40; round += 1) {
      // The Controller freed a slot on its side and opened a new stream; the CANCEL has not reached the Host yet.
      assert.equal(quota.admit('http').ok, false);
      clock.advance(50);
      held.shift()?.(); // ...and now the CANCEL arrives
      const next = quota.admit('http');
      assert.ok(next.ok);
      if (next.ok) held.push(next.release);
      clock.advance(50);
    }
    assert.equal(trips(), 0, 'close-lag at the boundary is not abuse');
    assert.equal(quota.recentViolations, 0);
  });

  it('sustained over-cap pressure with no slot ever freed still trips the limit (streams, PTY and WS)', () => {
    for (const [kind, limits] of [['http', { maxStreams: 2 }], ['pty', { maxPty: 1 }], ['ws', { maxWs: 1 }]] as const) {
      const { quota, clock, trips } = arrange(limits);
      open(quota, clock, kind, kind === 'http' ? 2 : 1);
      for (let index = 0; index < 25; index += 1) {
        assert.equal(quota.admit(kind).ok, false);
        clock.advance(100);
      }
      assert.equal(trips(), 1, `${kind}: more than 20 refusals in a minute with nothing freed`);
    }
  });

  it('a flood of policy denials counts as violations too', () => {
    const { quota, trips } = arrange();
    for (let index = 0; index < 20; index += 1) quota.noteViolation();
    assert.equal(trips(), 0);
    quota.noteViolation();
    assert.equal(trips(), 1);
  });

  it('a wall-clock step backwards cannot keep new streams out: windows ignore entries dated in the future', () => {
    const { quota, clock, trips } = arrange();
    for (let index = 0; index < 50; index += 1) {
      const result = quota.admit('http');
      if (result.ok) result.release();
    }
    clock.advance(-3_600_000); // NTP / VM resume moved the clock back an hour
    assert.ok(quota.admit('http').ok, 'not refused because of "recent" starts that lie an hour in the future');
    assert.equal(trips(), 0);
    assert.equal(quota.recentViolations, 0);
  });

  it('a throwing audit or disconnect hook never breaks admission', () => {
    const clock = createManualClock(0);
    const quota = createPairingQuota({
      limits: { maxStreams: 1, violationsPerMinute: 1 },
      clock,
      onReject() {
        throw new Error('audit down');
      },
      onViolationLimit() {
        throw new Error('disconnect failed');
      },
    });
    assert.ok(quota.admit('http').ok);
    assert.doesNotThrow(() => {
      for (let index = 0; index < 5; index += 1) assert.equal(quota.admit('http').ok, false);
    });
  });
});
