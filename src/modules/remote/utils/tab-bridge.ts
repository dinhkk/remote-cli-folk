import { TAB_TOKEN_REQUEST_MIN_INTERVAL_MS } from '@/shared/constants';
import { applyTabStorageWrite, readTabStorageSnapshot } from '@/shared/transport/controller-tab-storage';
import type { RemoteTabTokenGrant, TabPortMessage } from '@/shared/types';

/**
 * The Controller page's half of the page <-> tab link (contracts.md section 3).
 *
 * The sandboxed frame has an opaque origin, so `event.origin` proves nothing.
 * The page trusts a `ready` only when it comes from this exact frame window and
 * carries the nonce of this load, then hands the frame one MessagePort. The tab
 * token, the stored tab state and everything later travel over that port; the
 * token never goes through `window.postMessage`. The frame is untrusted code, so
 * what it sends is rate limited and what it may store is capped (see
 * controller-tab-storage.ts). Used by RemoteTabFrame.
 */

const MAX_PENDING_COUNT = 999;

// Message budget of one frame: more than any real tab sends, far less than a flood.
// A frame that blows the budget three seconds in a row, or by tenfold within one
// second, loses its port (the frame is then re-issued, or stays quiet).
const RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_WINDOW = 200;
const HARD_MESSAGE_LIMIT_PER_WINDOW = MAX_MESSAGES_PER_WINDOW * 10;
const MAX_ABUSIVE_WINDOWS = 3;

// Renewal: ask again at about half of the token's life, but never faster than every 30 s
// (a wrong clock must not turn into a request storm) and never later than every 30 min
// (also keeps the timer far below setTimeout's 2^31 ms limit).
const MIN_RENEW_DELAY_MS = 30_000;
const MAX_RENEW_DELAY_MS = 30 * 60_000;
const FALLBACK_TOKEN_LIFETIME_MS = 10 * 60_000;
const RENEW_RETRY_DELAY_MS = 10_000;
const MAX_RENEW_RETRIES = 3;

// The first token fetch of a frame is retried with growing pauses; after that the frame's own
// `token-expired` (at most once a minute) starts it again.
const INIT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/** What RemoteTabFrame needs from the link: report loads of its iframe, and tear it down. */
export type TabBridge = {
  /**
   * Call from the iframe's load event. The first load is the document we
   * paired with ('initial'); any later one means the frame navigated or
   * reloaded itself ('foreign'): the port is closed and the caller must re-issue
   * the frame's `src` with a fresh nonce.
   */
  handleFrameLoad: () => 'initial' | 'foreign';
  /** Stops listening, cancels renewal and closes the port. */
  dispose: () => void;
};

type TabBridgeOptions = {
  frame: HTMLIFrameElement;
  peerId: string;
  nonce: string;
  /** Asks the management API for a tab token for this peer. */
  getTabToken: () => Promise<RemoteTabTokenGrant>;
  /** Called with the number of permission cards waiting in the frame. */
  onPending: (count: number) => void;
  /** Window that receives the frame's `ready`; the page's own window unless a test supplies one. */
  parent?: Window;
  /** Clock for the rate limits; Date.now unless a test supplies one. */
  now?: () => number;
};

const decodeClaims = (token: string): Record<string, unknown> | null => {
  try {
    const encoded = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), '=')));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * How long a freshly issued token lives. The token's own `exp - iat` is on the
 * server's clock alone, so it is preferred; `expiresAt - now` depends on this
 * browser's clock and is only a fallback, and a value that is not in the future
 * (clock skew) is ignored.
 */
const tokenLifetimeMs = (grant: RemoteTabTokenGrant, now: number): number => {
  const claims = decodeClaims(grant.tabToken);
  const { iat, exp } = claims ?? {};
  if (typeof iat === 'number' && typeof exp === 'number' && Number.isFinite(iat) && Number.isFinite(exp) && exp > iat) {
    return (exp - iat) * 1000;
  }
  const raw = grant.expiresAt;
  const expiresAt = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (Number.isFinite(expiresAt) && expiresAt - now > 0) return expiresAt - now;
  return FALLBACK_TOKEN_LIFETIME_MS;
};

const renewalDelayMs = (grant: RemoteTabTokenGrant, now: number): number =>
  Math.min(MAX_RENEW_DELAY_MS, Math.max(MIN_RENEW_DELAY_MS, tokenLifetimeMs(grant, now) / 2));

/**
 * Starts listening for the frame's `ready`. Returns the handle the frame
 * component uses to report iframe loads and to dispose the link on unmount.
 */
export const createTabBridge = ({
  frame,
  peerId,
  nonce,
  getTabToken,
  onPending,
  parent = window,
  now = Date.now,
}: TabBridgeOptions): TabBridge => {
  let port: MessagePort | null = null;
  let portHandedOver = false;
  let disposed = false;
  let foreign = false;
  let loads = 0;
  // `init` (token + stored state) goes out once; every later grant is a plain `token`.
  let initSent = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let initRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTokenRequestAt = Number.NEGATIVE_INFINITY;
  let lastPendingCount = -1;
  // Message budget bookkeeping.
  let windowStartedAt = Number.NEGATIVE_INFINITY;
  let windowMessages = 0;
  let abusiveWindows = 0;

  const send = (message: TabPortMessage) => {
    port?.postMessage(message);
  };

  const scheduleRenewal = (grant: RemoteTabTokenGrant, attempt = 0) => {
    if (renewTimer) clearTimeout(renewTimer);
    const delay = attempt > 0 ? RENEW_RETRY_DELAY_MS : renewalDelayMs(grant, now());

    renewTimer = setTimeout(async () => {
      renewTimer = null;
      try {
        deliver(await getTabToken());
      } catch {
        if (!disposed && port && attempt < MAX_RENEW_RETRIES) scheduleRenewal(grant, attempt + 1);
      }
    }, delay);
  };

  /** Hands a fresh grant to the frame: `init` the first time, a plain `token` afterwards, then plans the renewal. */
  const deliver = (grant: RemoteTabTokenGrant) => {
    if (disposed || !port) return;
    if (initSent) {
      send({ type: 'token', token: grant.tabToken });
    } else {
      initSent = true;
      send({ type: 'init', peerId, tabToken: grant.tabToken, storageSnapshot: readTabStorageSnapshot(peerId) });
    }
    scheduleRenewal(grant);
  };

  /** Fetches a token for the frame. Until the frame has its `init`, a failure is retried with backoff instead of being dropped. */
  const issue = (attempt = 0) => {
    if (initRetryTimer) clearTimeout(initRetryTimer);
    initRetryTimer = null;
    getTabToken()
      .then(deliver)
      .catch(() => {
        const delay = INIT_RETRY_DELAYS_MS[attempt];
        if (disposed || !port || initSent || delay === undefined) return;
        initRetryTimer = setTimeout(() => {
          initRetryTimer = null;
          issue(attempt + 1);
        }, delay);
      });
  };

  const closeLink = () => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
    if (initRetryTimer) clearTimeout(initRetryTimer);
    initRetryTimer = null;
    if (port) {
      port.onmessage = null;
      port.close();
      port = null;
    }
  };

  /** Counts one message against the frame's budget; false means drop it (and the link is closed for a persistent flood). */
  const admitMessage = (): boolean => {
    const at = now();
    if (at - windowStartedAt >= RATE_WINDOW_MS) {
      abusiveWindows = windowMessages > MAX_MESSAGES_PER_WINDOW ? abusiveWindows + 1 : 0;
      windowStartedAt = at;
      windowMessages = 0;
      if (abusiveWindows >= MAX_ABUSIVE_WINDOWS) {
        closeLink();
        return false;
      }
    }
    windowMessages += 1;
    if (windowMessages > HARD_MESSAGE_LIMIT_PER_WINDOW) {
      closeLink();
      return false;
    }
    return windowMessages <= MAX_MESSAGES_PER_WINDOW;
  };

  const onPortMessage = (event: MessageEvent) => {
    if (!admitMessage()) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'token-expired') {
      // The frame is untrusted: one refresh a minute at most, whatever it sends.
      if (now() - lastTokenRequestAt < TAB_TOKEN_REQUEST_MIN_INTERVAL_MS) return;
      lastTokenRequestAt = now();
      issue();
      return;
    }

    if (message.type === 'pending') {
      const { count } = message;
      if (
        typeof count === 'number'
        && Number.isInteger(count)
        && count >= 0
        && count <= MAX_PENDING_COUNT
        && count !== lastPendingCount
      ) {
        lastPendingCount = count;
        onPending(count);
      }
      return;
    }

    if (message.type === 'storage-set') {
      applyTabStorageWrite(peerId, message);
    }
  };

  const onWindowMessage = (event: Event) => {
    if (disposed || foreign || portHandedOver) return;
    const { source, data } = event as MessageEvent;
    const frameWindow = frame.contentWindow;
    if (!frameWindow || source !== frameWindow) return;
    if (!data || typeof data !== 'object') return;
    const ready = data as { type?: unknown; nonce?: unknown };
    if (ready.type !== 'ready' || ready.nonce !== nonce) return;

    portHandedOver = true;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = onPortMessage;
    frameWindow.postMessage({ type: 'port' }, '*', [channel.port2]);

    issue();
  };

  parent.addEventListener('message', onWindowMessage);

  return {
    handleFrameLoad: () => {
      loads += 1;
      if (loads === 1) return 'initial';
      foreign = true;
      closeLink();
      return 'foreign';
    },
    dispose: () => {
      disposed = true;
      parent.removeEventListener('message', onWindowMessage);
      closeLink();
    },
  };
};
