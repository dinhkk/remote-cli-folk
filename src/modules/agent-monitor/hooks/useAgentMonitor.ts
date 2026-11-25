import { useCallback, useEffect, useState } from 'react';

import { isMonitorSnapshot, MonitorApiError, readMonitorJson, type MonitorErrorKind } from '@/modules/agent-monitor/data/readMonitorJson';
import { api } from '@/shared/api';
import type { AgentMonitorSnapshot } from '@/shared/types';

/** Time between polls while the screen is shown. Together with the server's instant aggregation this keeps the picture within ~1 s of the events. */
export const MONITOR_POLL_MS = 1000;

type MonitorStatus = 'loading' | 'ready' | 'error';

type AgentMonitorState = {
  snapshot: AgentMonitorSnapshot | null;
  status: MonitorStatus;
  /** Server clock minus this browser's clock at the last answer; add it to `Date.now()` to get server time (running timers use it). */
  clockOffsetMs: number;
  errorMessage: string | null;
  /** Why the last poll failed: `unreachable` = not the monitor's JSON (outdated or wrong server), `http` = the server's own error. */
  errorKind: MonitorErrorKind | null;
};

/**
 * Polls the monitor snapshot while `active` (the screen is open and the tab is visible). Requests never overlap, and a
 * failed poll keeps the last picture on screen with an error flag instead of blanking it. Stopping the polling is what
 * lets the server's CPU/RAM sampler and terminal reading stop, so `active` must go false whenever the screen is not on show.
 * An answer that is not the monitor's JSON is an error (never an empty picture): the screen then says the server may be
 * outdated and offers a retry.
 */
export function useAgentMonitor(active: boolean, pollMs: number = MONITOR_POLL_MS): AgentMonitorState & { retry: () => void } {
  // The last good answer plus where polling stands; the screen renders its loading/error text from `status`.
  const [state, setState] = useState<AgentMonitorState>({ snapshot: null, status: 'loading', clockOffsetMs: 0, errorMessage: null, errorKind: null });
  // A bumped counter restarts the loop at once (the "Try again" button).
  const [restart, setRestart] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Per loop, not shared: a loop restarted while an old request is still out (the screen closed and reopened on a slow
    // link) must not be blocked by that request, which belongs to the loop that was cancelled.
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await api.agentMonitor.snapshot();
        const snapshot = await readMonitorJson(response, isMonitorSnapshot);
        if (!cancelled) setState({ snapshot, status: 'ready', clockOffsetMs: snapshot.generatedAt - Date.now(), errorMessage: null, errorKind: null });
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            // A network failure (fetch rejected) is the same situation as a non-JSON answer: nothing usable arrived.
            errorKind: error instanceof MonitorApiError ? error.kind : 'unreachable',
          }));
        }
      } finally {
        inFlight = false;
        if (!cancelled) timer = setTimeout(poll, pollMs);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, pollMs, restart]);

  const retry = useCallback(() => setRestart((value) => value + 1), []);
  return { ...state, retry };
}
