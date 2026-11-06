/**
 * Receive-side throttle of the Controller (contracts section 6). The mux has no credit/window flow
 * control: a Host may send faster than a browser reads, and nothing slows it down. So the Controller
 * counts the bytes it has handed to the browser's response or socket but that the browser has not yet
 * taken (Node reports them as `writableLength` / `bufferedAmount`) and ends streams with `REMOTE_QUOTA`
 * instead of buffering without bound.
 *
 * Three budgets apply together: per stream, per pairing (all streams of one Host) and global (all
 * pairings). The per-stream cap alone is not enough: a hostile Host with many streams open could hold
 * `streams x cap` in memory. When an aggregate is over, the streams holding the most unread bytes are
 * cut first (largest first, until the total fits), which may be a stream that is not the one that just
 * received data.
 */

const MIB = 1024 * 1024;

/** Unread bytes tolerated per stream: the 8 MiB the sending side may queue, so a slow phone on a big download still works. */
// Consumed by: the Controller HTTP proxy and the WebSocket gateway (default budget).
export const DEFAULT_RECEIVE_BUDGET_BYTES = 8 * MIB;
/** Unread bytes tolerated across all streams of one pairing. */
// Consumed by: the receive ledger default.
export const DEFAULT_PAIRING_RECEIVE_BUDGET_BYTES = 32 * MIB;
/** Unread bytes tolerated across every pairing of this Controller. */
// Consumed by: the receive ledger default.
export const DEFAULT_GLOBAL_RECEIVE_BUDGET_BYTES = 128 * MIB;

export type ReceiveBudgets = { perStream: number; perPairing: number; global: number };

const ENV_KEYS = {
  perStream: 'CLOUDCLI_REMOTE_RECEIVE_BUDGET_STREAM_MIB',
  perPairing: 'CLOUDCLI_REMOTE_RECEIVE_BUDGET_PAIRING_MIB',
  global: 'CLOUDCLI_REMOTE_RECEIVE_BUDGET_GLOBAL_MIB',
} as const;

const DEFAULTS: ReceiveBudgets = {
  perStream: DEFAULT_RECEIVE_BUDGET_BYTES,
  perPairing: DEFAULT_PAIRING_RECEIVE_BUDGET_BYTES,
  global: DEFAULT_GLOBAL_RECEIVE_BUDGET_BYTES,
};

/**
 * The budgets in force: the defaults, overridden by `CLOUDCLI_REMOTE_RECEIVE_BUDGET_{STREAM,PAIRING,GLOBAL}_MIB`
 * (positive numbers of MiB; anything else is ignored) and then by explicit `overrides`.
 * Consumed by: the Remote module.
 */
export const resolveReceiveBudgets = (env: NodeJS.ProcessEnv = {}, overrides: Partial<ReceiveBudgets> = {}): ReceiveBudgets => {
  const resolved: ReceiveBudgets = { ...DEFAULTS };
  for (const key of Object.keys(ENV_KEYS) as Array<keyof ReceiveBudgets>) {
    const mib = Number(env[ENV_KEYS[key]]);
    if (Number.isFinite(mib) && mib > 0) resolved[key] = Math.floor(mib * MIB);
    const override = overrides[key];
    if (override !== undefined && Number.isFinite(override) && override > 0) resolved[key] = Math.floor(override);
  }
  return resolved;
};

/** True when more than `budgetBytes` are waiting for the browser to read. */
// Consumed by: the receive ledger.
export const exceedsReceiveBudget = (unreadBytes: number, budgetBytes: number): boolean => unreadBytes > budgetBytes;

/** What the ledger needs from one open stream: its unread bytes right now, and how to end it with `REMOTE_QUOTA`. */
export type ReceiveStream = { unread(): number; cancel(): void };

export type ReceiveTicket = {
  /** Call after handing data to the browser: cuts this stream, or the biggest holders, when a budget is exceeded. */
  enforce(): void;
  /** Call when the stream is over (idempotent). */
  release(): void;
};

export type ReceiveLedger = {
  track(peerId: string, stream: ReceiveStream): ReceiveTicket;
  /** Streams currently tracked (for tests). */
  readonly size: number;
};

/**
 * Creates the ledger shared by the HTTP proxy and the WebSocket gateway.
 * Consumed by: the Remote module (one per Controller), the proxy and gateway (a private one when none is given).
 */
export function createReceiveLedger(budgets: ReceiveBudgets = DEFAULTS): ReceiveLedger {
  type Entry = { peerId: string; stream: ReceiveStream };
  const entries = new Set<Entry>();

  const cut = (entry: Entry): void => {
    entries.delete(entry);
    entry.stream.cancel();
  };

  /** Cuts the biggest holder of `inScope` until the scope's total fits `limit`. */
  const fit = (inScope: (entry: Entry) => boolean, limit: number): void => {
    for (;;) {
      let total = 0;
      let biggest: Entry | null = null;
      let biggestBytes = -1;
      for (const entry of entries) {
        if (!inScope(entry)) continue;
        const unread = entry.stream.unread();
        total += unread;
        if (unread > biggestBytes) {
          biggest = entry;
          biggestBytes = unread;
        }
      }
      if (!biggest || !exceedsReceiveBudget(total, limit)) return;
      cut(biggest);
    }
  };

  return {
    track(peerId, stream) {
      const entry: Entry = { peerId, stream };
      entries.add(entry);
      return {
        enforce() {
          if (!entries.has(entry)) return;
          if (exceedsReceiveBudget(stream.unread(), budgets.perStream)) {
            cut(entry);
            return;
          }
          fit((candidate) => candidate.peerId === peerId, budgets.perPairing);
          fit(() => true, budgets.global);
        },
        release() {
          entries.delete(entry);
        },
      };
    },
    get size() {
      return entries.size;
    },
  };
}
