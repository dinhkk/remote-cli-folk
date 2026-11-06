/**
 * Spaces out the `/shell` WebSocket upgrades of each pairing (contracts section 1): the stock shell client
 * reconnects at once with no back-off, so the Controller lets one upgrade through per interval and delays
 * the rest, instead of refusing them.
 *
 * The wait is a real queue per pairing, not a reserved timestamp: it is bounded (a tab token holder cannot
 * park thousands of sockets here), a waiter whose browser went away leaves it (its slot goes to the next
 * one), and the caller decides what happens after the wait (the login is checked again by the gateway).
 */

export type ShellThrottleOptions = {
  /** Smallest gap between two upgrades of one pairing. */
  intervalMs: number;
  /** Upgrades that may wait per pairing; one more is answered `full`. */
  maxPending: number;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
};

/** `go`: carry on with the upgrade. `full`: too many are waiting. `aborted`: the browser left (or the signal fired) first. */
export type ShellThrottleResult = 'go' | 'full' | 'aborted';

type Waiter = { resolve(result: ShellThrottleResult): void; release(): void };
type PairingState = { lastAt: number; queue: Waiter[]; timer: NodeJS.Timeout | undefined };

/**
 * Creates the throttle.
 * Consumed by: the Controller WebSocket gateway.
 */
export function createShellUpgradeThrottle({ intervalMs, maxPending, now = Date.now }: ShellThrottleOptions) {
  const states = new Map<string, PairingState>();

  const stateOf = (peerId: string): PairingState => {
    let state = states.get(peerId);
    if (!state) {
      state = { lastAt: Number.NEGATIVE_INFINITY, queue: [], timer: undefined };
      states.set(peerId, state);
    }
    return state;
  };

  /** Arms the timer for the head of the queue, if there is one and no timer runs. */
  const schedule = (state: PairingState): void => {
    if (state.timer || state.queue.length === 0) return;
    const delay = Math.max(0, state.lastAt + intervalMs - now());
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const waiter = state.queue.shift();
      if (waiter) {
        state.lastAt = now();
        waiter.release();
        waiter.resolve('go');
      }
      schedule(state);
    }, delay);
    // Not unref'd: a queued upgrade is a live socket and must be answered (at most maxPending x interval).
  };

  return {
    /**
     * Waits for this pairing's next slot. Resolves `go` when the upgrade may proceed, `full` at once when
     * `maxPending` are already waiting, `aborted` when `signal` fires first (the waiter is dropped).
     */
    acquire(peerId: string, signal: AbortSignal): Promise<ShellThrottleResult> {
      if (signal.aborted) return Promise.resolve('aborted');
      const state = stateOf(peerId);
      if (state.queue.length === 0 && now() - state.lastAt >= intervalMs) {
        state.lastAt = now();
        return Promise.resolve('go');
      }
      if (state.queue.length >= maxPending) return Promise.resolve('full');
      return new Promise<ShellThrottleResult>((resolve) => {
        const onAbort = (): void => {
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          if (state.queue.length === 0 && state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
          }
          resolve('aborted');
        };
        const waiter: Waiter = { resolve, release: () => signal.removeEventListener('abort', onAbort) };
        signal.addEventListener('abort', onAbort, { once: true });
        state.queue.push(waiter);
        schedule(state);
      });
    },
  };
}

export type ShellUpgradeThrottle = ReturnType<typeof createShellUpgradeThrottle>;
