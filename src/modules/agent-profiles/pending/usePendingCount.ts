import { useCallback, useEffect, useRef, useState } from 'react';

import { onPendingChanged } from '@/modules/agent-profiles/pending/pending-events';
import { useVisiblePolling } from '@/modules/agent-profiles/pending/useVisiblePolling';
import { api, readApiJson } from '@/shared/api';
import { isTargetMode } from '@/shared/transport/target-context';

/** How often the count is read while the page is visible. */
const COUNT_POLL_MS = 60_000;

/**
 * How many proposals wait for the Host user. Read once, then about every 60 s while the page is visible, at once when it
 * becomes visible again and after a confirm or reject anywhere on screen. A failed read keeps the last number and says nothing
 * (no toast). In a Remote target the route is denied, so this never calls it and stays 0.
 * Used by the Settings badge of the sidebar and by the Pending tab of the agent-profiles panel.
 */
export function usePendingCount(): number {
  const host = !isTargetMode();
  const [count, setCount] = useState(0);
  // Only the newest read may set the count, so a slow older answer cannot undo a newer one.
  const latest = useRef(0);

  const read = useCallback(() => {
    const request = ++latest.current;
    api.agentProfiles.pendingCount()
      .then((response) => readApiJson<{ count: number }>(response))
      .then(
        (body) => {
          if (request === latest.current && Number.isInteger(body.count) && body.count >= 0) setCount(body.count);
        },
        () => undefined,
      );
  }, []);

  useEffect(() => {
    if (!host) return undefined;
    read();
    const stopListening = onPendingChanged(read);
    return () => {
      stopListening();
      // Answers still on the way belong to an unmounted screen.
      latest.current += 1;
    };
  }, [host, read]);

  useVisiblePolling(read, COUNT_POLL_MS, host);

  return host ? count : 0;
}
