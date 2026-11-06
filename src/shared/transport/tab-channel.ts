import type { StorageShim } from '@/shared/transport/storage-shim';
import {
  emitLinkEvent,
  isSessionExpired,
  onTabTokenChange,
  onTokenExpired,
  setTabToken,
} from '@/shared/transport/target-context';
import type { TabPortMessage, TabStorageSnapshot } from '@/shared/types';

/**
 * The frame's half of the link to the Controller page (contracts.md section 3).
 *
 * The frame says `ready` once, carrying the nonce it was loaded with, and
 * accepts a MessagePort only from `window.parent`. The page answers with the
 * port; the tab token, the storage snapshot and everything after that travel
 * over the port, never through `window.postMessage`. The sandbox gives the frame
 * an opaque origin, so `event.origin` cannot be checked; the source window plus
 * the nonce (checked by the page) are the identity.
 */

// How long a token request may stay unanswered before the tab is declared expired.
const TOKEN_REQUEST_PATIENCE_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

let port: MessagePort | null = null;
let lastReportedPending = 0;

const post = (message: TabPortMessage): void => {
  port?.postMessage(message);
};

const isSnapshotShape = (value: unknown): value is TabStorageSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const { local, session } = value as Record<string, unknown>;
  return Boolean(local) && typeof local === 'object' && Boolean(session) && typeof session === 'object';
};

/**
 * Tells the Controller page how many permission cards wait in this tab, so a
 * hidden tab can show a badge. Sends only changes; harmless without a link.
 * Used by the chat module.
 */
export const reportPendingCount = (count: number): void => {
  if (!port || count === lastReportedPending) {
    return;
  }
  lastReportedPending = count;
  post({ type: 'pending', count });
};

/**
 * Performs the frame's side of the handshake and resolves `true` once `init`
 * arrived (token set, storage filled, write mirroring on), or `false` when
 * there is no parent, no nonce, or the page did not answer in time. The boot
 * continues either way; without a token the tab shows "session expired".
 * Used by the transport bootstrap before the application is imported.
 */
export const connectToParent = ({
  nonce,
  peerId,
  shim,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  win = window,
}: {
  nonce: string | null;
  peerId: string;
  shim: StorageShim;
  timeoutMs?: number;
  win?: Window;
}): Promise<boolean> => {
  const parent = win.parent;
  // Not framed, or reloaded without a nonce: the page cannot pair us. When the
  // page notices the reload it reloads the frame with a fresh nonce.
  if (!parent || parent === win || !nonce) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let portAccepted = false;
    let initialized = false;
    let patience: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      win.removeEventListener('message', onWindowMessage);
      finish(false);
    }, timeoutMs);

    function finish(connected: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(connected);
    }

    // A request for a new token that nobody answers means the page cannot renew
    // the session (link gone, pairing revoked): say so instead of failing silently.
    const startPatience = () => {
      if (patience) return;
      patience = setTimeout(() => {
        patience = null;
        emitLinkEvent({ kind: 'session-expired' });
      }, TOKEN_REQUEST_PATIENCE_MS);
    };

    const onPortMessage = (event: MessageEvent) => {
      const message = event.data as Partial<TabPortMessage> | null;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'init') {
        if (
          initialized
          || message.peerId !== peerId
          || typeof message.tabToken !== 'string'
          || !isSnapshotShape(message.storageSnapshot)
        ) {
          return;
        }
        initialized = true;
        shim.loadSnapshot(message.storageSnapshot);
        shim.setWriteListener((write) => post({ type: 'storage-set', ...write }));
        // The token listener is already registered (see onWindowMessage), so this also
        // lifts a session-expired cover when init arrives after the boot gave up waiting.
        setTabToken(message.tabToken);
        finish(true);
        return;
      }

      if (message.type === 'token' && initialized && typeof message.token === 'string') {
        setTabToken(message.token);
      }
    };

    function onWindowMessage(event: MessageEvent) {
      if (portAccepted || event.source !== parent) return;
      const data = event.data as { type?: unknown } | null;
      const offered = event.ports?.[0];
      if (!data || data.type !== 'port' || !offered) return;

      portAccepted = true;
      win.removeEventListener('message', onWindowMessage);
      port = offered;
      offered.onmessage = onPortMessage;

      // From here the page can answer token requests, including before it has sent
      // `init` (its first token fetch may have failed): a frame that never got a token
      // asks for one over the port and the page answers with `init`.
      onTokenExpired(() => {
        post({ type: 'token-expired' });
        startPatience();
      });
      onTabTokenChange((token) => {
        if (!token) return;
        if (patience) {
          clearTimeout(patience);
          patience = null;
        }
        if (isSessionExpired()) {
          emitLinkEvent({ kind: 'session-restored' });
        }
      });
    }

    win.addEventListener('message', onWindowMessage);
    parent.postMessage({ type: 'ready', nonce }, '*');
  });
};
