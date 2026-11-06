/**
 * The Controller's paired Hosts and the relay links to them (contracts sections 1 and 2).
 *
 * Links are lazy: nothing connects until a browser asks (`GET /peers`, opening a tab, a proxied
 * request), and every link closes five minutes after the last browser touched it or the last browser
 * connection ended, which spares the relay's free quota. A browser connection (proxied HTTP request or
 * WebSocket) registers itself with `trackConnection`, which both keeps the links open and lets this
 * registry end it when the pairing is forgotten, the session drops, or the auth epoch changes.
 *
 * `PeerState` comes from the link status (contracts section 2); `expired` comes from the pairing's own
 * idle expiry. A pairing whose key cannot be opened simply reads `offline`.
 */

import type {
  RemoteBrowserConnection,
  RemoteClock,
  RemoteMuxLimits,
  RemotePairingRecord,
  RemotePairingStore,
  RemotePeerState,
  RemotePeerView,
  RemoteRelayLink,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { RemoteLinkDownError, type RelayLinkOptions } from '../link/relay-link.js';

const DEFAULT_IDLE_CLOSE_MS = 5 * 60_000;
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60_000;
/** Close code told to a browser socket whose link dropped: "try again", the browser reconnects and resubscribes. */
const LINK_DOWN_CLOSE = 1013;

export type PeerRegistryOptions = {
  store: Pick<RemotePairingStore, 'listPairings' | 'getPairing' | 'openPairingKey' | 'deletePairing' | 'markConnected' | 'touchActivity' | 'setPairingAlias'>;
  /** Idle expiry (FR-40): a pairing idle past the limit is expired when it is looked at (its key is erased). */
  expiry?: { enforce(record: RemotePairingRecord): RemotePairingRecord };
  /** The saved `RELAY_SECRET`, or null when none is saved. */
  getRelaySecret(): string | null;
  /** False in modes where a Controller must not run (API_KEY, platform): no link is ever opened. */
  isSupported(): boolean;
  clock: RemoteClock;
  appVersion: string;
  createLink(options: RelayLinkOptions): RemoteRelayLink;
  idleCloseMs?: number;
  limits?: Partial<RemoteMuxLimits>;
};

type LinkEntry = { link: RemoteRelayLink; unsubscribe: Array<() => void> };

const notFound = (): AppError => new AppError('No such paired Host.', { statusCode: 404, code: 'REMOTE_PEER_NOT_FOUND' });
const expiredError = (): AppError => new AppError('This pairing has expired. Pair the Host again.', { statusCode: 410, code: 'REMOTE_PEER_EXPIRED' });

/**
 * Creates the Controller peer registry.
 * Consumed by: the management API (peers, tab tokens, forget), the Controller proxy and the WebSocket gateway.
 */
export function createPeerRegistry(options: PeerRegistryOptions) {
  const { store, clock } = options;
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const links = new Map<string, LinkEntry>();
  /**
   * Peers whose link was asked for by real use (a tab or proxied request, `attach`) and not only by a list
   * view: the session coming up for those renews the pairing's idle timer; for a link a Settings list opened
   * by itself it only records "last connected".
   */
  const usedPeers = new Set<string>();
  const connections = new Map<string, Set<RemoteBrowserConnection>>();
  let lastTouch = 0;
  let cancelIdleTimer: (() => void) | undefined;

  const connectionCount = (): number => {
    let total = 0;
    for (const set of connections.values()) total += set.size;
    return total;
  };

  // ---------------------------------------------------------------- browser connections

  /** Ends the connections of one peer (or all); returns how many were ended. */
  const closeConnections = (peerId?: string, code = LINK_DOWN_CLOSE, reason = 'link-down'): number => {
    let closed = 0;
    const targets = peerId === undefined ? [...connections.keys()] : [peerId];
    for (const id of targets) {
      const set = connections.get(id);
      if (!set) continue;
      connections.delete(id);
      for (const connection of set) {
        closed += 1;
        try {
          connection.close(code, reason);
        } catch {
          // A connection that is already gone must not stop the others from being closed.
        }
      }
    }
    return closed;
  };

  // ---------------------------------------------------------------- idle lease

  const closeLinks = (): void => {
    cancelIdleTimer?.();
    cancelIdleTimer = undefined;
    for (const entry of links.values()) {
      for (const stop of entry.unsubscribe) stop();
      entry.link.close();
    }
    links.clear();
    usedPeers.clear();
    closeConnections(undefined, LINK_DOWN_CLOSE, 'link-closed');
  };

  const onIdleCheck = (): void => {
    cancelIdleTimer = undefined;
    if (links.size === 0) return;
    const idleFor = clock.now() - lastTouch;
    if (connectionCount() > 0 || idleFor < idleCloseMs) {
      cancelIdleTimer = clock.setTimer(onIdleCheck, connectionCount() > 0 ? idleCloseMs : idleCloseMs - idleFor);
      return;
    }
    closeLinks();
  };

  /** A browser is attached right now: the links stay for another lease. */
  const touch = (): void => {
    lastTouch = clock.now();
    cancelIdleTimer ??= clock.setTimer(onIdleCheck, idleCloseMs);
  };

  // ---------------------------------------------------------------- links

  /** Ends the link and browser connections of a pairing that is gone or expired (the row is not touched). */
  const dropLink = (peerId: string, code: number, reason: string): void => {
    closeConnections(peerId, code, reason);
    usedPeers.delete(peerId);
    const entry = links.get(peerId);
    if (!entry) return;
    for (const stop of entry.unsubscribe) stop();
    entry.link.close();
    links.delete(peerId);
  };

  /** The idle check: an expired pairing loses its link right away, whoever noticed first (use, listing or the sweep). */
  const enforceIdle = (record: RemotePairingRecord): RemotePairingRecord => {
    const fresh = options.expiry?.enforce(record) ?? record;
    if (fresh.expiresAt !== record.expiresAt) dropLink(record.id, 4410, 'pairing-expired');
    return fresh;
  };

  const controllerRecord = (peerId: string): RemotePairingRecord | null => {
    const record = store.getPairing(peerId);
    if (!record || record.role !== 'controller') return null;
    return enforceIdle(record);
  };

  /** Renews the pairing's activity mark at most every 5 minutes (a day-scale limit does not need more). */
  const lastActivityWrite = new Map<string, number>();
  const noteActivity = (peerId: string): void => {
    const now = clock.now();
    if (now - (lastActivityWrite.get(peerId) ?? Number.NEGATIVE_INFINITY) < ACTIVITY_WRITE_INTERVAL_MS) return;
    lastActivityWrite.set(peerId, now);
    try {
      store.touchActivity(peerId);
    } catch {
      // Bookkeeping only: the request being served must not fail because of it.
    }
  };

  /** The link for a pairing, created and started on first use; null when none may be opened right now. */
  const ensureLink = (record: RemotePairingRecord): RemoteRelayLink | null => {
    const existing = links.get(record.id);
    if (existing) return existing.link;
    const relaySecret = options.getRelaySecret();
    if (!relaySecret || !options.isSupported()) return null;

    const k = store.openPairingKey(record.id);
    let link: RemoteRelayLink;
    try {
      link = options.createLink({
        role: 'controller',
        k,
        relayUrl: record.relayUrl,
        relaySecret,
        appVersion: options.appVersion,
        clock,
        limits: options.limits,
      });
    } finally {
      k.fill(0); // the link keeps its own copy
    }
    const unsubscribe = [
      link.on('session', (event) => {
        if (event.up) store.markConnected(record.id, { renewActivity: usedPeers.has(record.id) });
        else closeConnections(record.id, LINK_DOWN_CLOSE, 'link-down');
      }),
    ];
    links.set(record.id, { link, unsubscribe });
    link.start();
    return link;
  };

  const isExpiredRecord = (record: RemotePairingRecord): boolean => record.expiresAt !== null && clock.now() >= record.expiresAt;

  const stateOf = (record: RemotePairingRecord): RemotePeerState => {
    if (isExpiredRecord(record)) return 'expired';
    return links.get(record.id)?.link.status.peerState ?? 'offline';
  };

  return {
    /** The Controller pairings with their state; counts as a browser being attached and opens the links. */
    listPeers(): RemotePeerView[] {
      const peers = store.listPairings('controller').map(enforceIdle);
      for (const record of peers) {
        if (isExpiredRecord(record)) continue;
        try {
          ensureLink(record);
        } catch {
          // This pairing cannot connect (key unreadable); it reads offline and the others still work.
        }
      }
      touch();
      return peers.map((record) => ({
        peerId: record.id,
        name: record.peerName,
        alias: record.alias,
        state: stateOf(record),
        lastConnectedAt: record.lastConnectedAt,
      }));
    },

    /** Sets (or, with null, clears) the name this user gives a Host. Local only: nothing is sent to the Host or the relay. */
    setAlias(peerId: string, alias: string | null): void {
      if (!controllerRecord(peerId)) throw notFound();
      store.setPairingAlias(peerId, alias);
    },

    /** True when `peerId` is one of this Controller's pairings (an expired one is still listed, so it can be forgotten). */
    hasPeer: (peerId: string): boolean => controllerRecord(peerId) !== null,

    /** True when `peerId` is a pairing whose `expires_at` has passed: no link, tab token or proxying for it. */
    isExpired: (peerId: string): boolean => {
      const record = controllerRecord(peerId);
      return record !== null && isExpiredRecord(record);
    },

    /**
     * The link to one Host for a request or an upgrade: opens it if needed and renews the lease. Throws
     * `AppError` 404 for an unknown peer, 410 `REMOTE_PEER_EXPIRED` for an expired pairing and
     * `RemoteLinkDownError` when no link can be opened (no relay secret saved, unsupported mode,
     * unreadable key). The caller still checks `sessionActive`.
     */
    attach(peerId: string): RemoteRelayLink {
      const record = controllerRecord(peerId);
      if (!record) throw notFound();
      if (isExpiredRecord(record)) throw expiredError();
      let link: RemoteRelayLink | null;
      try {
        link = ensureLink(record);
      } catch {
        throw new RemoteLinkDownError();
      }
      if (!link) throw new RemoteLinkDownError();
      usedPeers.add(peerId);
      touch();
      noteActivity(peerId);
      return link;
    },

    /** Ends the link and browser connections of a pairing that was just expired by the periodic job (the row stays, as `expired`). */
    dropExpired(peerId: string): void {
      dropLink(peerId, 4410, 'pairing-expired');
    },

    /** Registers a browser connection of `peerId`; the returned function unregisters it (and renews the lease). */
    trackConnection(peerId: string, connection: RemoteBrowserConnection): () => void {
      const set = connections.get(peerId) ?? new Set<RemoteBrowserConnection>();
      set.add(connection);
      connections.set(peerId, set);
      touch();
      return () => {
        if (!set.delete(connection)) return;
        if (set.size === 0 && connections.get(peerId) === set) connections.delete(peerId);
        touch();
      };
    },

    closeConnections,
    closeLinks,

    /** The Controller forgets a Host: its link and browser connections end, the pairing row is deleted. */
    forget(peerId: string): void {
      if (!controllerRecord(peerId)) throw notFound();
      closeConnections(peerId, 4410, 'pairing-forgotten');
      usedPeers.delete(peerId);
      const entry = links.get(peerId);
      if (entry) {
        for (const stop of entry.unsubscribe) stop();
        entry.link.close();
        links.delete(peerId);
      }
      store.deletePairing(peerId);
    },

    /** Links currently open (for tests and diagnostics). */
    get openLinkCount(): number {
      return links.size;
    },
  };
}

export type PeerRegistry = ReturnType<typeof createPeerRegistry>;
