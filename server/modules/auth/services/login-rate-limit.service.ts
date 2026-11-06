import { isIPv6 } from 'node:net';

export type LoginRateLimiterOptions = {
  now?: () => number;
  maxEntries?: number;
  pairMaxFailures?: number;
  ipMaxFailures?: number;
  windowMs?: number;
  lockMs?: number;
};

export type LoginRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type LoginAttempt =
  | { allowed: false; retryAfterSeconds: number }
  | { allowed: true; /** Call when the credential check passed: refunds the reserved slot and clears the pair. */ succeeded(): void };

export type LoginRateLimiter = {
  /** Read-only: is this client currently locked? Consumes nothing. */
  check(ip: string, username: string): LoginRateLimitDecision;
  /**
   * Start a guarded attempt. If allowed, a failure slot is reserved immediately (before any
   * slow password hashing), so concurrent requests cannot all slip in under the limit;
   * the caller refunds it through `succeeded()` only when the credential check passes.
   */
  attempt(ip: string, username: string): LoginAttempt;
  recordFailure(ip: string, username: string): void;
  /** Clears the pair's failures. Does not touch the per-IP count (use `attempt().succeeded()`). */
  recordSuccess(ip: string, username: string): void;
  size(): number;
};

type Entry = {
  /** Timestamps of recent failures inside the counting window. */
  failures: number[];
  lockedUntil: number;
};

const DEFAULTS = {
  maxEntries: 10_000,
  pairMaxFailures: 5,
  ipMaxFailures: 20,
  windowMs: 10 * 60_000,
  lockMs: 15 * 60_000,
};

// When the table is full, evict down to this share in one pass so the O(n) sweep runs once per
// many failures instead of once per failure.
const EVICTION_TARGET = 0.9;

const USERNAME_KEY_MAX_LENGTH = 128;
const CLIENT_KEY_MAX_LENGTH = 64;

/** First four hextets of an IPv6 address in canonical (unpadded, lowercase) form. */
function ipv6Prefix64(address: string): string {
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups];
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':');
}

/**
 * Canonical limiter key for a client address: IPv4-mapped IPv6 collapses to IPv4, other IPv6
 * addresses collapse to their /64 (a single subscriber owns a whole /64, so per-address keys
 * would let one attacker rotate through 2^64 identities), and anything else is length-capped.
 */
function clientKey(ip: string): string {
  const address = ip.trim().toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) {
    return mapped[1];
  }
  if (isIPv6(address)) {
    return `v6/${ipv6Prefix64(address)}`;
  }
  return address.slice(0, CLIENT_KEY_MAX_LENGTH);
}

/**
 * In-memory failed-login limiter: a pair lock (ip + username) and a coarser per-IP lock.
 *
 * State lives in one capped Map and is lost on restart (accepted: an attacker gains at most one
 * fresh window per restart). When full, expired entries go first, then unlocked entries oldest
 * first, and locked entries only as a last resort — so spraying many usernames cannot unlock a
 * target pair that was already locked.
 */
export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
  const pairMaxFailures = options.pairMaxFailures ?? DEFAULTS.pairMaxFailures;
  const ipMaxFailures = options.ipMaxFailures ?? DEFAULTS.ipMaxFailures;
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const lockMs = options.lockMs ?? DEFAULTS.lockMs;

  const entries = new Map<string, Entry>();

  const pairKey = (ip: string, username: string) =>
    `pair\u0000${clientKey(ip)}\u0000${username.trim().toLowerCase().slice(0, USERNAME_KEY_MAX_LENGTH)}`;
  const ipKey = (ip: string) => `ip\u0000${clientKey(ip)}`;

  const isExpired = (entry: Entry, at: number) =>
    entry.lockedUntil <= at && entry.failures.every((failedAt) => failedAt <= at - windowMs);

  function evictIfFull(at: number) {
    if (entries.size <= maxEntries) {
      return;
    }
    const target = Math.floor(maxEntries * EVICTION_TARGET);

    for (const [key, entry] of entries) {
      if (entries.size <= target) {
        return;
      }
      if (isExpired(entry, at)) {
        entries.delete(key);
      }
    }
    for (const [key, entry] of entries) {
      if (entries.size <= target) {
        return;
      }
      if (entry.lockedUntil <= at) {
        entries.delete(key);
      }
    }
    for (const key of entries.keys()) {
      if (entries.size <= target) {
        return;
      }
      entries.delete(key);
    }
  }

  function recordInto(key: string, maxFailures: number, at: number) {
    const entry = entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((failedAt) => failedAt > at - windowMs);
    entry.failures.push(at);
    if (entry.failures.length >= maxFailures) {
      // Failures are kept (not reset) so a refund by the attempt that tipped the count over
      // can undo the lock it caused. They age out of the window long before the lock ends.
      entry.lockedUntil = at + lockMs;
    }
    // Re-insert so Map order approximates "least recently active first".
    entries.delete(key);
    entries.set(key, entry);
  }

  function remainingLockSeconds(key: string, at: number): number {
    const entry = entries.get(key);
    if (!entry || entry.lockedUntil <= at) {
      return 0;
    }
    return Math.ceil((entry.lockedUntil - at) / 1000);
  }

  const check: LoginRateLimiter['check'] = (ip, username) => {
    const at = now();
    const retryAfterSeconds = Math.max(
      remainingLockSeconds(pairKey(ip, username), at),
      remainingLockSeconds(ipKey(ip), at),
    );
    return retryAfterSeconds > 0 ? { allowed: false, retryAfterSeconds } : { allowed: true };
  };

  const recordFailure: LoginRateLimiter['recordFailure'] = (ip, username) => {
    const at = now();
    recordInto(pairKey(ip, username), pairMaxFailures, at);
    recordInto(ipKey(ip), ipMaxFailures, at);
    evictIfFull(at);
  };

  return {
    check,
    recordFailure,

    attempt(ip, username) {
      const decision = check(ip, username);
      if (!decision.allowed) {
        return decision;
      }
      recordFailure(ip, username);
      // Did this very reservation tip the IP over its limit? Then its refund must lift that lock.
      const lockedHere = remainingLockSeconds(ipKey(ip), now()) > 0;
      return {
        allowed: true,
        succeeded: () => {
          entries.delete(pairKey(ip, username));
          const ipEntry = entries.get(ipKey(ip));
          if (ipEntry) {
            ipEntry.failures.pop();
            if (lockedHere) {
              ipEntry.lockedUntil = 0;
            }
          }
        },
      };
    },

    recordSuccess(ip, username) {
      // Only the pair is cleared: a correct password must not erase the per-IP failure count.
      entries.delete(pairKey(ip, username));
    },

    size() {
      return entries.size;
    },
  };
}
