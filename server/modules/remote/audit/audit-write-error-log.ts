/**
 * Diagnostics for audit write failures. The audit service never lets a failed write fail the request being
 * audited, which would leave a full disk or a locked database completely invisible; this hook makes it a
 * line on the console, at most once per interval. Only an error NAME is ever printed (never a message, a
 * path or a row), and failures in between are counted and reported with the next line.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;

export type WriteErrorLoggerOptions = {
  /** Milliseconds; only differences matter (use a monotonic source). */
  now(): number;
  warn(line: string): void;
  intervalMs?: number;
};

/**
 * Creates the `onWriteError` hook of the audit service.
 * Consumed by: the Remote runtime.
 */
export function createWriteErrorLogger(options: WriteErrorLoggerOptions): (errorName: string) => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let lastLogAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;

  return (errorName) => {
    const now = options.now();
    if (now - lastLogAt < intervalMs && now >= lastLogAt) {
      suppressed += 1;
      return;
    }
    const name = SAFE_NAME.test(errorName) ? errorName : 'Error';
    const more = suppressed > 0 ? ` (${suppressed} more failure${suppressed === 1 ? '' : 's'} since the last message)` : '';
    lastLogAt = now;
    suppressed = 0;
    try {
      options.warn(`[WARN] Remote audit write failed: ${name}${more}`);
    } catch {
      // Logging must never throw into the request being audited.
    }
  };
}
