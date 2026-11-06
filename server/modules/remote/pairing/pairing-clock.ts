/**
 * Real time source for the pairing services (tests substitute a manual `RemoteClock`).
 */

import type { RemoteClock } from '@/shared/types.js';

/**
 * Wall clock plus `setTimeout` whose timers never keep the process alive.
 * Consumed by: the Host and Controller pairing services as their default clock.
 */
export const systemClock: RemoteClock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
