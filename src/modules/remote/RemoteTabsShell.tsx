import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteTabs } from '@/modules/remote/hooks/useRemoteTabs';
import { RemoteTabFrame } from '@/modules/remote/RemoteTabFrame';
import { onOpenRemoteTabRequest } from '@/modules/remote/utils/open-remote-tab-request';
import { peerDisplayName } from '@/modules/remote/utils/peer-display-name';
import { PEER_STATE_DOT_CLASS } from '@/modules/remote/utils/peer-state-dot-class';
import { purgeRemoteTabStorage } from '@/shared/transport/controller-tab-storage';
import type { RemotePeer, RemotePeerState } from '@/shared/types';

const LOCAL_TAB = 'local';
const TITLE_PREFIX_PATTERN = /^\(\d+\) /;

// A pairing in one of these states can never serve a frame; the tab says why instead.
const DEAD_STATES: ReadonlySet<RemotePeerState> = new Set(['revoked', 'replaced', 'locked', 'expired']);

const tabClass = (selected: boolean) =>
  `flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
    selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
  }`;

/**
 * Wraps the Local app with a tab bar for paired Hosts. Without a pairing it adds
 * nothing but a `display: contents` box, so Local looks and behaves exactly as
 * before. With pairings the bar lists Local first, then one tab per Host; each
 * Remote tab is a sandboxed frame created on first visit and then only hidden,
 * never unmounted, so its session and scroll state survive tab switches.
 * The element tree is the same either way, which keeps the Local app mounted
 * when the first pairing appears. Rendered by App inside ProtectedRoute.
 *
 * `indicator` lets the caller place a status pill: it is asked for a `tabbar`
 * version (rendered at the end of the bar, never over a tab) when the bar exists,
 * and for an `overlay` version when it does not.
 */
export function RemoteTabsShell({
  children,
  indicator,
}: {
  children: ReactNode;
  indicator?: (placement: 'tabbar' | 'overlay') => ReactNode;
}) {
  const { t } = useTranslation('remote');
  const { peers, requestTabToken } = useRemoteTabs();

  // Which tab is in front; falls back to Local when its pairing disappears.
  const [selected, setSelected] = useState<string>(LOCAL_TAB);
  // Pairings whose frame was opened at least once, so frames load lazily.
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  // Permission cards waiting in each Remote tab, as the tab's frame reports them.
  const [pending, setPending] = useState<Readonly<Record<string, number>>>({});

  const hasPeers = peers.length > 0;
  const activeId = peers.some((peer) => peer.peerId === selected) ? selected : LOCAL_TAB;

  const select = useCallback((id: string) => {
    setSelected(id);
    if (id !== LOCAL_TAB) {
      setVisited((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
    }
  }, []);

  // Settings' "Open tab" button asks for a Host's tab by id; a Host that is not paired (any more) is ignored.
  const peersRef = useRef(peers);
  useEffect(() => {
    peersRef.current = peers;
  });
  useEffect(
    () =>
      onOpenRemoteTabRequest((peerId) => {
        if (peersRef.current.some((peer) => peer.peerId === peerId)) select(peerId);
      }),
    [select],
  );

  // What a tab kept (drafts, last project, ...) came from its Host: once the Host revoked
  // the pairing nothing will use it again, so it is deleted (once per pairing and page load).
  const purgedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const peer of peers) {
      if ((peer.state === 'revoked' || peer.state === 'replaced') && !purgedIds.current.has(peer.peerId)) {
        purgedIds.current.add(peer.peerId);
        purgeRemoteTabStorage(peer.peerId);
      }
    }
  }, [peers]);

  const handlePending = useCallback((peerId: string, count: number) => {
    setPending((previous) => (previous[peerId] === count ? previous : { ...previous, [peerId]: count }));
  }, []);

  // Cards waiting in tabs the user cannot see: badge each tab and prefix the browser title with the sum.
  const hiddenPending = useMemo(
    () =>
      peers.reduce(
        (sum, peer) => (peer.peerId === activeId ? sum : sum + (pending[peer.peerId] ?? 0)),
        0,
      ),
    [peers, pending, activeId],
  );

  useEffect(() => {
    const base = document.title.replace(TITLE_PREFIX_PATTERN, '');
    document.title = hiddenPending > 0 ? `(${hiddenPending}) ${base}` : base;
  }, [hiddenPending]);
  useEffect(
    () => () => {
      document.title = document.title.replace(TITLE_PREFIX_PATTERN, '');
    },
    [],
  );

  const renderTab = (peer: RemotePeer) => {
    const isActive = peer.peerId === activeId;
    const count = isActive ? 0 : (pending[peer.peerId] ?? 0);
    return (
      <button
        key={peer.peerId}
        type="button"
        role="tab"
        aria-selected={isActive}
        data-state={peer.state}
        onClick={() => select(peer.peerId)}
        className={tabClass(isActive)}
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${PEER_STATE_DOT_CLASS[peer.state]}`} />
        <span className="max-w-40 truncate" title={peer.alias ? peer.name : undefined}>
          {peerDisplayName(peer)}
        </span>
        {count > 0 && (
          <span
            data-pending-badge
            className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs font-semibold text-primary-foreground"
          >
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className={hasPeers ? 'fixed inset-0 flex flex-col bg-background' : 'contents'}>
      {hasPeers && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-2 py-1">
          {/* The tabs scroll sideways inside their own box, so the indicator beside them is never covered or pushed off. */}
          <div role="tablist" aria-label={t('tabs.label')} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <button
              type="button"
              role="tab"
              aria-selected={activeId === LOCAL_TAB}
              onClick={() => select(LOCAL_TAB)}
              className={tabClass(activeId === LOCAL_TAB)}
            >
              {t('tabs.local')}
            </button>
            {peers.map(renderTab)}
          </div>
          {indicator?.('tabbar')}
        </div>
      )}
      {/* No tab bar to sit in: a floating pill, which is fixed-position and so cannot shift the app. */}
      {!hasPeers && indicator?.('overlay')}

      {/*
        `contain: layout` makes this box the containing block of the app's own
        `fixed inset-0` shell, so the tab bar is not painted over; without a
        pairing the box is `display: contents` and nothing changes.
      */}
      <div
        className={
          !hasPeers
            ? 'contents'
            : activeId === LOCAL_TAB
              ? 'relative min-h-0 flex-1 [contain:layout]'
              : 'hidden'
        }
      >
        {children}
      </div>

      {peers.map((peer) => {
        if (!visited.has(peer.peerId)) {
          return null;
        }
        if (DEAD_STATES.has(peer.state)) {
          if (peer.peerId !== activeId) {
            return null;
          }
          return (
            <div key={peer.peerId} className="flex min-h-0 flex-1 items-center justify-center p-6">
              <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">
                {t(`tabs.state.${peer.state}`)}
              </p>
            </div>
          );
        }
        return (
          <RemoteTabFrame
            key={peer.peerId}
            peerId={peer.peerId}
            name={peerDisplayName(peer)}
            hidden={peer.peerId !== activeId}
            requestTabToken={requestTabToken}
            onPending={handlePending}
          />
        );
      })}
    </div>
  );
}
