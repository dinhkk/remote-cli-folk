/**
 * Token bucket for policy-violation reports. Every refused stream of a hostile (but paired) Controller
 * produces a violation, and the owner of the bridge turns those into audit rows: without a limit the
 * Controller writes to the Host's audit table at link speed. The bucket starts full (`burst` reports),
 * refills `perSecond` tokens per second and never holds more than `burst`. The refusal of the stream
 * itself is never limited, only the report.
 */

/** Options of one bucket. `now` returns milliseconds (monotonic preferred); injected by tests. */
export type ViolationRateLimiterOptions = {
  /** Bucket capacity: how many reports may come in one burst. Integer >= 1. */
  burst: number;
  /** Tokens added per second after the burst is spent. 0 = never refill. */
  perSecond: number;
  now?: () => number;
};

/** One bucket (one per link, see `createHostBridge`). */
export type ViolationRateLimiter = {
  /** Takes one token: true when the report may go on, false (and counted) when it must be dropped. */
  tryConsume(): boolean;
  /** Reports refused so far. */
  readonly suppressed: number;
};

/** Absorbs the rounding of fractional tokens (`0.998 + 0.002` is not exactly 1 in floating point). */
const EPSILON = 1e-9;

// Consumed by: host-bridge (one bucket per attached link and one for streams served without a link).
export function createViolationRateLimiter(options: ViolationRateLimiterOptions): ViolationRateLimiter {
  const { burst, perSecond } = options;
  if (!Number.isInteger(burst) || burst < 1) throw new Error('The violation burst must be an integer of at least 1');
  if (!Number.isFinite(perSecond) || perSecond < 0) throw new Error('The violation perSecond must be a finite number of at least 0');
  const now = options.now ?? (() => performance.now());

  let tokens = burst;
  let last = now();
  let suppressed = 0;

  return {
    tryConsume() {
      const current = now();
      // A clock that went backwards credits nothing (and is taken as the new reference).
      const elapsedMs = Math.max(0, current - last);
      last = current;
      tokens = Math.min(burst, tokens + (elapsedMs * perSecond) / 1000);
      if (tokens >= 1 - EPSILON) {
        tokens = Math.max(0, tokens - 1);
        return true;
      }
      suppressed += 1;
      return false;
    },
    get suppressed() {
      return suppressed;
    },
  };
}
