import { useCallback, useEffect, useRef, useState } from 'react';

import { REMOTE_FRAME_REISSUE_MIN_INTERVAL_MS } from '@/shared/constants';
import { createTabBridge } from '@/modules/remote/utils/tab-bridge';
import type { TabBridge } from '@/modules/remote/utils/tab-bridge';
import type { RemoteTabTokenGrant } from '@/shared/types';

// allow-same-origin is included to support WebKit/Safari engines (such as mobile iOS browsers)
// where an opaque origin breaks fetch/CSP requests to the host endpoints.
// In-tab memory storage shim isolates tab storage from the Controller page.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals';

/** 16 random bytes as 32 hex characters: the one-time value that ties a `ready` message to this load of the frame. */
const createNonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

type RemoteTabFrameProps = {
  peerId: string;
  /** Host name, for the frame's accessible title. */
  name: string;
  /** The tab is not in front; the frame stays mounted and keeps its state. */
  hidden: boolean;
  requestTabToken: (peerId: string) => Promise<RemoteTabTokenGrant>;
  /** Number of permission cards waiting in this tab, reported by the frame. */
  onPending: (peerId: string, count: number) => void;
};

/**
 * One Remote tab: the whole application in a sandboxed iframe aimed at one Host,
 * plus the page-side link that hands it a token. The nonce is fixed per load and
 * only changes when the frame has to be re-issued (below), which also replaces
 * the iframe element so the new document is guaranteed to boot from scratch.
 * Used by RemoteTabsShell.
 */
export function RemoteTabFrame({ peerId, name, hidden, requestTabToken, onPending }: RemoteTabFrameProps) {
  const [nonce, setNonce] = useState(createNonce);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<TabBridge | null>(null);
  const lastReissueAt = useRef(Number.NEGATIVE_INFINITY);
  const reissueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The bridge outlives renders; the latest callbacks are read through refs so
  // a new function identity from the parent never rebuilds the link.
  const requestTabTokenRef = useRef(requestTabToken);
  const onPendingRef = useRef(onPending);
  useEffect(() => {
    requestTabTokenRef.current = requestTabToken;
    onPendingRef.current = onPending;
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const bridge = createTabBridge({
      frame,
      peerId,
      nonce,
      getTabToken: () => requestTabTokenRef.current(peerId),
      onPending: (count) => onPendingRef.current(peerId, count),
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [peerId, nonce]);

  useEffect(
    () => () => {
      if (reissueTimer.current) clearTimeout(reissueTimer.current);
    },
    [],
  );

  // A second document in this frame (it reloaded or navigated itself) was never
  // paired, so it must not get a token. Start over with a fresh nonce, at most
  // once per interval so a frame that reloads in a loop cannot spin the page.
  const handleLoad = useCallback(() => {
    if (bridgeRef.current?.handleFrameLoad() !== 'foreign' || reissueTimer.current) return;
    const wait = Math.max(0, REMOTE_FRAME_REISSUE_MIN_INTERVAL_MS - (Date.now() - lastReissueAt.current));
    reissueTimer.current = setTimeout(() => {
      reissueTimer.current = null;
      lastReissueAt.current = Date.now();
      setNonce(createNonce());
    }, wait);
  }, []);

  return (
    <div className={hidden ? 'hidden' : 'relative min-h-0 flex-1'} data-remote-pane={peerId}>
      <iframe
        key={nonce}
        ref={frameRef}
        title={name}
        src={`/?target=${peerId}#n=${nonce}`}
        sandbox={SANDBOX}
        allow="clipboard-write; clipboard-read"
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
        className="h-full w-full border-0 bg-background"
      />
    </div>
  );
}
