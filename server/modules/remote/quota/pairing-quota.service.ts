/**
 * Per-pairing quota (FR-39, AC-30): what ONE paired Controller may hold open on a Host. Counters are
 * per pairing (one instance per Host link), freed when the stream closes, and use an injectable clock
 * (production passes a MONOTONIC one, so a wall-clock step cannot hold streams out; entries dated in the
 * future are ignored as well).
 *
 * Limits (defaults): 64 concurrent streams of any kind, 8 PTY (`/shell`), 8 chat sockets (`/ws`), 50 new
 * streams per rolling second. An excess is refused (`admit` returns `ok:false`; the bridge answers the
 * stream with `ERROR REMOTE_QUOTA`, HTTP 429 at the Controller) and every refusal is reported (audited).
 *
 * Which refusals are VIOLATIONS (more than 20 in a rolling minute calls `onViolationLimit` once; the owner
 * suspends the pairing):
 * - PTY and WS cap refusals, and `streams` refusals that persist (nothing is ever freed), and policy-denial
 *   floods (`noteViolation`): genuine cap abuse.
 * - NOT `rate` refusals: a cold page load legitimately opens dozens of requests at once.
 * - NOT a `streams` refusal at the boundary that close-lag explains: one slot freed within 2 seconds of the
 *   refusal (before or after it) forgives that one refusal, so a Controller that cancels a stream and opens
 *   the next one before the Host has seen the cancel is not punished. One freed slot forgives one refusal.
 *
 * Closes the SERVER caused (overload 1013, queue overflow) are not violations either: `noteServerClose`
 * banks a forgiveness credit that absorbs the next refusal, so a Controller's honest reconnect loop after
 * such a close cannot trip the auto-disconnect. Credits are capped, and one credit is spent per refusal.
 *
 * Refused attempts do not use up the per-second allowance (otherwise a flood would keep the window shut
 * for everybody else); only admitted streams do.
 */

import type { RemoteClock, RemoteQuotaLimits, RemoteQuotaReason, RemoteStreamQuota } from '@/shared/types.js';

export const DEFAULT_QUOTA_LIMITS: RemoteQuotaLimits = {
  maxStreams: 64,
  maxPty: 8,
  maxWs: 8,
  newStreamsPerSecond: 50,
  violationsPerMinute: 20,
};

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
/** A freed slot and a boundary refusal this close together (either order) are close-lag, not abuse. */
const CLOSE_LAG_MS = 2_000;
/** Server-closed streams that may be forgiven at once. */
const MAX_FORGIVENESS_CREDITS = 16;

/** Entries of a rolling window: not in the future (a clock step back) and younger than the window. */
const within = (at: number, now: number, windowMs: number): boolean => at <= now && now - at < windowMs;

export type PairingQuotaOptions = {
  limits?: Partial<RemoteQuotaLimits>;
  /** Milliseconds; only differences matter. Production passes a monotonic source, tests a manual clock. */
  clock: Pick<RemoteClock, 'now'>;
  /** A stream was refused (audit: one row per call). Must not throw; a throw is ignored. */
  onReject?(reason: RemoteQuotaReason): void;
  /** More than `violationsPerMinute` counted refusals in a minute; called once per trip, the window restarts. */
  onViolationLimit?(): void;
};

export type PairingQuota = RemoteStreamQuota & {
  noteViolation(): void;
  /** Streams currently holding a slot (leak checks, status). */
  readonly active: { streams: number; pty: number; ws: number };
  /** Counted violations inside the current minute. */
  readonly recentViolations: number;
};

const positive = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

/** Limits with every field a positive integer (a bad override falls back to the default). */
export const resolveQuotaLimits = (overrides: Partial<RemoteQuotaLimits> = {}): RemoteQuotaLimits => ({
  maxStreams: positive(overrides.maxStreams, DEFAULT_QUOTA_LIMITS.maxStreams),
  maxPty: positive(overrides.maxPty, DEFAULT_QUOTA_LIMITS.maxPty),
  maxWs: positive(overrides.maxWs, DEFAULT_QUOTA_LIMITS.maxWs),
  newStreamsPerSecond: positive(overrides.newStreamsPerSecond, DEFAULT_QUOTA_LIMITS.newStreamsPerSecond),
  violationsPerMinute: positive(overrides.violationsPerMinute, DEFAULT_QUOTA_LIMITS.violationsPerMinute),
});

/**
 * Creates the quota of one pairing.
 * Consumed by: the Remote runtime (one per Host link), handed to the Host bridge.
 */
export function createPairingQuota(options: PairingQuotaOptions): PairingQuota {
  const limits = resolveQuotaLimits(options.limits);
  const { clock } = options;
  const active = { streams: 0, pty: 0, ws: 0 };
  /** Admission times (ms) of streams started in the last second. */
  let recentStarts: number[] = [];
  /** Counted violations; `boundary` ones (a `streams` refusal) can still be forgiven by a slot freed right after. */
  let violations: Array<{ at: number; boundary: boolean }> = [];
  /** Slots freed lately that have not forgiven a refusal yet (each forgives at most one). */
  let freedSlots: number[] = [];
  let credits = 0;

  const safely = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch {
      // A broken audit/disconnect hook must never break admission.
    }
  };

  const countViolation = (boundary: boolean): void => {
    const now = clock.now();
    violations = violations.filter((entry) => within(entry.at, now, MINUTE_MS));
    violations.push({ at: now, boundary });
    if (violations.length > limits.violationsPerMinute) {
      violations = [];
      safely(options.onViolationLimit);
    }
  };

  const refuse = (reason: RemoteQuotaReason): { ok: false; reason: RemoteQuotaReason } => {
    safely(() => options.onReject?.(reason));
    if (reason === 'rate') return { ok: false, reason }; // a burst is not abuse: reported, never counted
    if (credits > 0) {
      credits -= 1;
    } else if (reason === 'streams') {
      const now = clock.now();
      freedSlots = freedSlots.filter((at) => within(at, now, CLOSE_LAG_MS));
      // A slot freed a moment ago explains this refusal (the Controller already counts it as free).
      if (freedSlots.length > 0) freedSlots.shift();
      else countViolation(true);
    } else {
      countViolation(false);
    }
    return { ok: false, reason };
  };

  /** A slot was freed: it forgives the latest boundary refusal of the last 2 seconds, or is remembered for the next one. */
  const noteFreedSlot = (): void => {
    const now = clock.now();
    freedSlots = freedSlots.filter((at) => within(at, now, CLOSE_LAG_MS));
    for (let index = violations.length - 1; index >= 0; index -= 1) {
      const entry = violations[index];
      if (entry.boundary && within(entry.at, now, CLOSE_LAG_MS)) {
        violations.splice(index, 1);
        return;
      }
    }
    freedSlots.push(now);
  };

  return {
    get active() {
      return { ...active };
    },
    get recentViolations() {
      const now = clock.now();
      return violations.filter((entry) => within(entry.at, now, MINUTE_MS)).length;
    },

    admit(kind) {
      const now = clock.now();
      recentStarts = recentStarts.filter((at) => within(at, now, SECOND_MS));
      if (recentStarts.length >= limits.newStreamsPerSecond) return refuse('rate');
      if (active.streams >= limits.maxStreams) return refuse('streams');
      if (kind === 'pty' && active.pty >= limits.maxPty) return refuse('pty');
      if (kind === 'ws' && active.ws >= limits.maxWs) return refuse('ws');

      recentStarts.push(now);
      active.streams += 1;
      if (kind === 'pty') active.pty += 1;
      if (kind === 'ws') active.ws += 1;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          active.streams -= 1;
          if (kind === 'pty') active.pty -= 1;
          if (kind === 'ws') active.ws -= 1;
          noteFreedSlot();
        },
      };
    },

    noteServerClose() {
      credits = Math.min(MAX_FORGIVENESS_CREDITS, credits + 1);
    },

    noteViolation() {
      countViolation(false);
    },
  };
}
