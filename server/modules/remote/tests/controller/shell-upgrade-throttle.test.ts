/**
 * The `/shell` upgrade throttle of one Controller: one upgrade per interval per pairing, a bounded queue,
 * and a waiter whose browser went away leaves the queue (its slot is not lost to the next one).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createShellUpgradeThrottle } from '../../controller/shell-upgrade-throttle.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const never = new AbortController().signal;

describe('shell upgrade throttle', () => {
  it('lets the first upgrade through at once and spaces the following ones of the same pairing', async () => {
    const throttle = createShellUpgradeThrottle({ intervalMs: 80, maxPending: 4 });
    const startedAt = Date.now();
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await throttle.acquire('p1', never), 'go');
      times.push(Date.now() - startedAt);
    }
    assert.ok(times[0] < 40, `first at ${times[0]}`);
    assert.ok(times[1] >= 75, `second at ${times[1]}`);
    assert.ok(times[2] >= 155, `third at ${times[2]}`);
  });

  it('does not delay another pairing', async () => {
    const throttle = createShellUpgradeThrottle({ intervalMs: 200, maxPending: 4 });
    await throttle.acquire('p1', never);
    const startedAt = Date.now();
    assert.equal(await throttle.acquire('p2', never), 'go');
    assert.ok(Date.now() - startedAt < 50);
  });

  it('refuses ("full") an upgrade that would be queued behind maxPending others', async () => {
    const throttle = createShellUpgradeThrottle({ intervalMs: 60, maxPending: 2 });
    await throttle.acquire('p1', never);
    const queued = [throttle.acquire('p1', never), throttle.acquire('p1', never)];
    assert.equal(await throttle.acquire('p1', never), 'full');
    assert.deepEqual(await Promise.all(queued), ['go', 'go']);
    // The queue drained: a new upgrade after the interval is accepted again.
    await sleep(70);
    assert.equal(await throttle.acquire('p1', never), 'go');
  });

  it('removes an aborted waiter from the queue and gives its slot to the next one', async () => {
    const throttle = createShellUpgradeThrottle({ intervalMs: 150, maxPending: 4 });
    await throttle.acquire('p1', never);
    const startedAt = Date.now();
    const gone = new AbortController();
    const abandoned = throttle.acquire('p1', gone.signal);
    const next = throttle.acquire('p1', never);
    await sleep(20);
    gone.abort();
    assert.equal(await abandoned, 'aborted');
    assert.equal(await next, 'go');
    assert.ok(Date.now() - startedAt < 260, `the next upgrade waited ${Date.now() - startedAt} ms: one interval, not two`);
  });

  it('answers "aborted" at once for a signal that is already aborted, without taking a slot', async () => {
    const throttle = createShellUpgradeThrottle({ intervalMs: 200, maxPending: 4 });
    const gone = new AbortController();
    gone.abort();
    assert.equal(await throttle.acquire('p1', gone.signal), 'aborted');
    const startedAt = Date.now();
    assert.equal(await throttle.acquire('p1', never), 'go');
    assert.ok(Date.now() - startedAt < 50);
  });

  it('an interval of 0 never delays', async () => {
    const throttle = createShellUpgradeThrottle({ intervalMs: 0, maxPending: 1 });
    for (let i = 0; i < 5; i += 1) assert.equal(await throttle.acquire('p1', never), 'go');
  });
});
