import { useCallback } from 'react';

import { useRemotePolling } from '@/modules/remote/hooks/useRemotePolling';
import { api } from '@/shared/api';
import type { RemotePeer, RemoteTabTokenGrant } from '@/shared/types';

/**
 * Pairings of this Controller, for the Remote tab bar (contracts.md section 2).
 * The peers come from the shared Remote poll (`tabs` mode), not from a poll of
 * their own: one request on load, then every 2 s only while a pairing exists,
 * backing off while the server fails and pausing while the page is hidden.
 * A failed poll keeps the last known peers (live frames stay mounted); only a
 * definitive "no Remote module" answer empties the list. Someone who never pairs
 * costs a single request, and a server without the module costs one per page load.
 *
 * This is the only place the tab bar learns about pairings and the only caller
 * of the tab-token endpoint; the pairing UI and the management API are wired
 * through `api.remote` in shared/api.ts. Used by RemoteTabsShell.
 */
export const useRemoteTabs = (): {
  peers: RemotePeer[];
  isLoading: boolean;
  hasError: boolean;
  refresh: () => Promise<void>;
  requestTabToken: (peerId: string) => Promise<RemoteTabTokenGrant>;
} => {
  const { snapshot, refresh } = useRemotePolling('tabs');

  const requestTabToken = useCallback(async (peerId: string): Promise<RemoteTabTokenGrant> => {
    const response = await api.remote.tabToken(peerId);
    if (!response.ok) {
      throw new Error(`Tab token request failed (${response.status})`);
    }
    const body: unknown = await response.json();
    const { tabToken, expiresAt } = (body ?? {}) as Partial<RemoteTabTokenGrant>;
    if (typeof tabToken !== 'string' || (typeof expiresAt !== 'string' && typeof expiresAt !== 'number')) {
      throw new Error('Tab token response was malformed');
    }
    return { tabToken, expiresAt };
  }, []);

  return { peers: snapshot.peers, isLoading: !snapshot.loaded, hasError: Boolean(snapshot.failure) && snapshot.available, refresh, requestTabToken };
};
