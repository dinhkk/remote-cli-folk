import { parseHostStatus } from '@/modules/remote/utils/parse-remote-responses';
import { parseRemotePeers } from '@/modules/remote/utils/parse-remote-peers';
import { MALFORMED_RESPONSE_CODE, readRemoteResult } from '@/modules/remote/utils/remote-api-result';
import { api } from '@/shared/api';
import { REMOTE_PEERS_POLL_INTERVAL_MS } from '@/shared/constants';
import type { RemoteApiResult, RemoteHostStatus, RemotePeer, RemoteStatusSnapshot } from '@/shared/types';

/**
 * `full` is the Remote settings screen: it needs the Host status and the peers and
 * keeps polling while it is open. `tabs` is the Remote tab bar: it needs only the
 * peers and keeps polling while a pairing exists (or while the server is failing,
 * so it recovers on its own). `indicator` is the Local "n Controllers connected"
 * badge: it needs only the Host status and keeps polling only while Accept is on.
 */
export type RemotePollMode = 'full' | 'tabs' | 'indicator';

type Subscriber = { mode: RemotePollMode; listener: () => void };

// After a failure the gap doubles (4 s, 8 s, ...) up to this ceiling.
const MAX_BACKOFF_MS = 30_000;

const EMPTY_SNAPSHOT: RemoteStatusSnapshot = { loaded: false, available: true, host: null, peers: [], failure: null };

const isPageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

// Keeps the previous reference when a poll brought nothing new, so screens do not re-render every 2 s for nothing.
const keepIfSame = <T>(previous: T, next: T): T => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next);

// 404 (or the SPA shell answering) is the only definitive "this server has no Remote module";
// every other failure (network, 5xx, 401, ...) is transient and keeps what was last known.
const isUnavailable = (result: RemoteApiResult<unknown>): boolean =>
  !result.ok && (result.status === 404 || result.code === MALFORMED_RESPONSE_CODE);

// A failure worth retrying on its own: the network, a server that is down or busy, or a session that
// is being renewed. Any other refusal (403, 409 REMOTE_UNSUPPORTED_MODE, ...) will not change by asking again.
const isTransientFailure = (result: RemoteApiResult<unknown>): boolean =>
  !result.ok && (result.status === 0 || result.status >= 500 || result.status === 401 || result.status === 408 || result.status === 429);

const createRemoteStatusPoller = () => {
  let snapshot = EMPTY_SNAPSHOT;
  const subscribers = new Set<Subscriber>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The poll in progress, so a second request for fresh data joins it instead of doubling the traffic.
  let current: Promise<void> | null = null;
  let failures = 0;
  // Whether the last cycle failed in a way that is worth retrying without being asked (see isTransientFailure).
  let retryable = false;
  // Bumped when the last screen leaves, so an answer that arrives afterwards is discarded.
  let epoch = 0;

  const has = (mode: RemotePollMode) => [...subscribers].some((subscriber) => subscriber.mode === mode);
  const wantsPeers = () => has('full') || has('tabs');
  // The Local badge reads the Host status once, then only while Accept is on (or when asked to refresh).
  const wantsHost = (force: boolean) =>
    has('full') || (has('indicator') && (force || snapshot.host === null || snapshot.host.acceptEnabled));
  const shouldKeepPolling = () =>
    subscribers.size > 0
    && snapshot.available
    && (has('full')
      || (has('tabs') && (snapshot.peers.length > 0 || retryable))
      || (has('indicator') && (snapshot.host?.acceptEnabled === true || retryable)));

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const publish = (next: RemoteStatusSnapshot) => {
    snapshot = next;
    for (const subscriber of [...subscribers]) subscriber.listener();
  };

  const schedule = () => {
    clearTimer();
    if (!shouldKeepPolling() || isPageHidden()) return;
    const delay = failures === 0 ? REMOTE_PEERS_POLL_INTERVAL_MS : Math.min(REMOTE_PEERS_POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
    timer = setTimeout(() => void poll(), delay);
  };

  const poll = (force = false): Promise<void> => {
    clearTimer();
    if (subscribers.size === 0) return Promise.resolve();
    if (current) return current;
    const myEpoch = epoch;
    const needPeers = wantsPeers();
    const needHost = wantsHost(force);

    const readHost = () => readRemoteResult(() => api.remote.hostStatus(), parseHostStatus);
    const readPeers = () =>
      readRemoteResult(() => api.remote.peers(), (body) => (Array.isArray(body) ? parseRemotePeers(body) : null));

    const run = async () => {
      let hostResult: RemoteApiResult<RemoteHostStatus> | null = null;
      let peersResult: RemoteApiResult<RemotePeer[]> | null = null;
      if (snapshot.loaded) {
        [hostResult, peersResult] = await Promise.all([
          needHost ? readHost() : Promise.resolve(null),
          needPeers ? readPeers() : Promise.resolve(null),
        ]);
      } else {
        // Before the module is known to exist, ask for one thing first: a server
        // without Remote then answers 404 once and costs a single request per page load.
        if (needPeers) peersResult = await readPeers();
        if (needHost && !(peersResult && isUnavailable(peersResult))) hostResult = await readHost();
      }
      if (myEpoch !== epoch) return;

      const results: Array<RemoteApiResult<unknown>> = [];
      if (hostResult) results.push(hostResult);
      if (peersResult) results.push(peersResult);
      const unavailable = results.some(isUnavailable);
      const failed = results.find((result) => !result.ok) ?? null;
      failures = failed && !unavailable ? failures + 1 : 0;
      retryable = failed !== null && !unavailable && isTransientFailure(failed);

      publish({
        loaded: true,
        available: unavailable ? false : results.some((result) => result.ok) ? true : snapshot.available,
        host: unavailable ? null : hostResult?.ok ? keepIfSame(snapshot.host, hostResult.data) : snapshot.host,
        peers: unavailable
          ? keepIfSame(snapshot.peers, [])
          : peersResult?.ok
            ? keepIfSame(snapshot.peers, peersResult.data)
            : snapshot.peers,
        failure: failed && !failed.ok ? { status: failed.status, code: failed.code } : null,
      });
      schedule();
    };

    current = run().finally(() => {
      if (myEpoch === epoch) current = null;
    });
    return current;
  };

  // Polls after the current microtask, so screens that mount in the same commit share one first request.
  // A poll already in flight is followed by a fresh one that also covers what the newcomer needs.
  let kickQueued = false;
  const kick = () => {
    if (kickQueued) return;
    kickQueued = true;
    queueMicrotask(() => {
      kickQueued = false;
      if (subscribers.size === 0 || isPageHidden()) return;
      if (current) {
        void current.then(() => {
          if (subscribers.size > 0 && snapshot.available) void poll();
        });
      } else {
        void poll();
      }
    });
  };

  const onVisibilityChange = () => {
    if (isPageHidden()) {
      clearTimer();
    } else if (subscribers.size > 0 && (!snapshot.loaded || shouldKeepPolling())) {
      void poll();
    }
  };

  return {
    subscribe(mode: RemotePollMode, listener: () => void): () => void {
      const hadFull = has('full');
      const hadPeersWatcher = wantsPeers();
      const subscriber: Subscriber = { mode, listener };
      subscribers.add(subscriber);
      if (subscribers.size === 1) {
        document.addEventListener('visibilitychange', onVisibilityChange);
        kick();
      } else if (
        (mode === 'full' && !hadFull)
        || (mode === 'tabs' && !hadPeersWatcher)
        || (mode === 'indicator' && snapshot.host === null && snapshot.available)
      ) {
        // A screen joined a poll that was not reading what it needs.
        clearTimer();
        kick();
      }

      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
        clearTimer();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        epoch += 1;
        current = null;
        failures = 0;
        retryable = false;
        snapshot = EMPTY_SNAPSHOT;
      };
    },
    getSnapshot: (): RemoteStatusSnapshot => snapshot,
    /** Reads fresh data now (after an action, or to wake an idle poll) and resolves when it has been published. */
    refresh: (): Promise<void> => {
      clearTimer();
      return poll(true);
    },
  };
};

/** The one poll the whole Remote UI shares: the tab bar, Settings and the Local indicator read the same answers instead of each asking. */
export const sharedRemoteStatusPoller = createRemoteStatusPoller();
