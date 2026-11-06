import { useCallback, useSyncExternalStore } from 'react';

import { sharedRemoteStatusPoller } from '@/modules/remote/utils/remote-status-poller';
import type { RemotePollMode } from '@/modules/remote/utils/remote-status-poller';
import type { RemoteStatusSnapshot } from '@/shared/types';

/**
 * The single poll behind the Remote UI (contracts.md section 2): `GET /host/status`
 * and `GET /peers` every 2 s, doubling up to 30 s while the server fails, asleep
 * while the page is hidden. Every screen that calls this shares one set of
 * requests; `refresh` re-reads at once after an action. A server without the
 * Remote module costs one request per page load, and an idle Host (Accept off) none
 * after that. A failed poll keeps what was last known; only a 404 / SPA-shell answer
 * means "no Remote module".
 * Used by RemoteSettingsTab (`full`), RemoteTabsShell via useRemoteTabs (`tabs`:
 * peers only) and HostControllerIndicator (`indicator`: Host status only).
 */
export const useRemotePolling = (
  mode: RemotePollMode,
): { snapshot: RemoteStatusSnapshot; refresh: () => Promise<void> } => {
  const subscribe = useCallback(
    (listener: () => void) => sharedRemoteStatusPoller.subscribe(mode, listener),
    [mode],
  );
  const snapshot = useSyncExternalStore(subscribe, sharedRemoteStatusPoller.getSnapshot);
  return { snapshot, refresh: sharedRemoteStatusPoller.refresh };
};
