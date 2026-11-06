/**
 * Manually driven `RemoteClock` for pairing tests. `advance` fires due timers in order (so a
 * service reacts at its exact deadline), then moves the optional linked fake relay to the same
 * instant, which keeps the service's 5-minute code lifetime and the relay's pair-room TTL in step.
 */

import type { RemoteClock } from '@/shared/types.js';

import type { FakeRelay } from './fake-relay.js';

export type ManualClock = RemoteClock & {
  advance(ms: number): void;
  /** Number of timers that are scheduled and not yet fired or cancelled. */
  pendingTimers(): number;
};

export const createManualClock = (startMs: number, relay?: FakeRelay): ManualClock => {
  let current = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => current,
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: current + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    pendingTimers: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId: number | undefined;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === undefined) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        current = Math.max(current, dueAt);
        timer?.callback();
      }
      current = target;
      if (relay) relay.advance(Math.max(0, target - relay.now()));
    },
  };
};
