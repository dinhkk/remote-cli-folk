/**
 * Host Accept: the switch that lets paired Controllers reach this machine (FR-5/6/14/15/16/17).
 *
 * While Accept is on, every active Host pairing has one relay link (opened with the pairing key K,
 * which never leaves this process) and one Host bridge attached to it, so the Controller's mux streams
 * become loopback calls. Off means: every link closed, every stream cut. The switch is persisted in the
 * `remote.accept_*` keys, with an optional auto-off (0-168 hours) that a 60-second tick checks (no long
 * timer: it would fire late after a laptop sleep and could not be cancelled cleanly on restart).
 * After a restart Accept is restored only if it was on and its deadline has not passed.
 *
 * Links are reconciled by `syncLinks`, which the status read and the tick call: a pairing that finished
 * after Accept was switched on gets its link within a couple of seconds (the UI polls the status), and a
 * pairing revoked elsewhere loses its link. Revoke erases K, then asks the relay to destroy the room; if
 * the relay cannot be reached the pending-destroy retrier owes the DESTROY (`relayConfirmed: false`).
 */

import type { HostBridge } from '@/modules/remote/bridge/host-bridge.js';
import type {
  RemoteClock,
  RemoteHostControllerView,
  RemoteAuditEvent,
  RemoteAuditRecorder,
  RemoteHostStatusView,
  RemoteMuxLimits,
  RemotePairingRecord,
  RemotePairingStore,
  RemoteRelayLink,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { SecretBoxError } from '../crypto/secret-box.js';
import type { RelayLinkOptions } from '../link/relay-link.js';

const KEY_ENABLED = 'remote.accept_enabled';
const KEY_AUTO_OFF_HOURS = 'remote.accept_auto_off_hours';
const KEY_ENABLED_AT = 'remote.accept_enabled_at';
const MAX_AUTO_OFF_HOURS = 168;
const HOUR_MS = 3_600_000;
const TICK_MS = 60_000;

/** Where the persisted switch lives: the throwing `remote.*` config repository in production. */
export type AcceptSettings = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type HostAcceptOptions = {
  store: Pick<
    RemotePairingStore,
    'listPairings' | 'getPairing' | 'openPairingKey' | 'revokeHostPairing' | 'deletePairing' | 'markConnected' | 'expirePairing'
  >;
  settings: AcceptSettings;
  /** The saved `RELAY_SECRET`, or null when none is saved. */
  getRelaySecret(): string | null;
  /** False in modes where Remote must not run (platform mode). */
  isSupported(): boolean;
  clock: RemoteClock;
  /** Milliseconds of a MONOTONIC clock; measures how long a suspension lasts (default: `clock.now`). */
  monotonicNow?: () => number;
  appVersion: string;
  createLink(options: RelayLinkOptions): RemoteRelayLink;
  /** One bridge per Controller link, so the stream count and the quota are per Controller. */
  createBridge(pairing: { pairingId: string; name: string }): HostBridge;
  /** Immediate DESTROY attempt after a revoke; the retrier handles the rest. */
  pendingDestroy: { destroyNow(pairingId: string): Promise<boolean> };
  /** Effective `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` (FR-31). */
  approvalTimeoutMs(): number;
  limits?: Partial<RemoteMuxLimits>;
  /** Audit trail of connect, disconnect, revoke, idle expiry and quota disconnects (never throws). */
  audit?: RemoteAuditRecorder;
  /** Idle expiry rule (FR-40); a pairing that is idle past the limit is expired instead of served. */
  expiry?: { isIdleExpired(record: RemotePairingRecord): boolean };
};

type Entry = {
  link: RemoteRelayLink;
  bridge: HostBridge;
  /** When the current Controller session came up (epoch ms), null while there is none. */
  connectedAt: number | null;
  unsubscribe: Array<() => void>;
};

const notFound = (): AppError => new AppError('No such Controller pairing.', { statusCode: 404, code: 'REMOTE_PAIR_NOT_FOUND' });
const badRequest = (message: string): AppError => new AppError(message, { statusCode: 400, code: 'REMOTE_BAD_REQUEST' });

/**
 * Creates the Host Accept service.
 * Consumed by: the Remote runtime (management API, auth epoch hook, relay settings).
 */
export function createHostAcceptService(options: HostAcceptOptions) {
  const { store, settings, clock } = options;
  const entries = new Map<string, Entry>();
  let enabled = false;
  let cancelTick: (() => void) | undefined;

  // ---------------------------------------------------------------- persisted state

  const readNumber = (key: string): number => {
    const parsed = Number.parseInt(settings.get(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const autoOffHours = (): number => Math.min(readNumber(KEY_AUTO_OFF_HOURS), MAX_AUTO_OFF_HOURS);
  const autoOffAt = (): number | null => {
    const hours = autoOffHours();
    return enabled && hours > 0 ? readNumber(KEY_ENABLED_AT) + hours * HOUR_MS : null;
  };

  // ---------------------------------------------------------------- links

  const isActive = (record: RemotePairingRecord): boolean =>
    record.role === 'host' && record.revokedAt === null && (record.expiresAt === null || record.expiresAt > clock.now());

  const subjectOf = (record: RemotePairingRecord) => ({ pairingId: record.id, label: record.peerName });
  const audit = (record: RemotePairingRecord, event: RemoteAuditEvent): void => options.audit?.record(subjectOf(record), event);

  /**
   * Pairings that may not reconnect until a time is up (auto-disconnected for repeated quota violations). The
   * deadline is kept twice: on a MONOTONIC clock (what decides, so a wall-clock step cannot shorten or extend
   * it) and as wall-clock epoch milliseconds (what the Host view shows). Expired entries are dropped when read.
   */
  const monotonicNow = options.monotonicNow ?? (() => clock.now());
  const suspensions = new Map<string, { untilMonotonic: number; untilWall: number }>();
  const suspensionOf = (id: string): { untilMonotonic: number; untilWall: number } | undefined => {
    const suspension = suspensions.get(id);
    if (suspension && monotonicNow() >= suspension.untilMonotonic) {
      suspensions.delete(id);
      return undefined;
    }
    return suspension;
  };
  const isSuspended = (id: string): boolean => suspensionOf(id) !== undefined;

  /**
   * Idle expiry (FR-40): the link and streams end, K is erased, the relay room is destroyed (the retrier owes
   * the DESTROY if the relay is unreachable) and the pairing no longer exists as an active one. A pairing whose
   * key can never be opened again (`SecretBoxError`) is deleted instead (nothing is left to destroy), like a
   * revoke. Any other failure (a locked or full database) is transient: the row stays untouched, the pairing is
   * not served meanwhile, and the next check tries again. Never throws. Returns whether the pairing is expired now.
   */
  const expireIdle = (record: RemotePairingRecord): boolean => {
    try {
      closeEntry(record.id);
      try {
        store.expirePairing(record.id);
      } catch (error) {
        if (!(error instanceof SecretBoxError)) return false;
        store.deletePairing(record.id);
        audit(record, { event: 'expire', target: 'idle', result: 'ok', detail: { relayDestroy: 'not-owed' } });
        return true;
      }
    } catch {
      return false; // the delete itself failed: retried by the next check
    }
    // The row is expired and the DESTROY is owed; the audit row says how the immediate attempt went.
    let attempt: Promise<boolean>;
    try {
      attempt = options.pendingDestroy.destroyNow(record.id);
    } catch (error) {
      attempt = Promise.reject(error);
    }
    void attempt.then(
      (confirmed) => audit(record, { event: 'expire', target: 'idle', result: 'ok', detail: { relayDestroy: confirmed ? 'confirmed' : 'queued' } }),
      () => audit(record, { event: 'expire', target: 'idle', result: 'error', detail: { relayDestroy: 'failed' } }),
    );
    return true;
  };

  /** Active pairings; one found idle past the limit is expired on the spot (the check at connect time) and never served. */
  const activePairings = (): RemotePairingRecord[] => {
    const result: RemotePairingRecord[] = [];
    for (const record of store.listPairings('host')) {
      if (!isActive(record)) continue;
      if (options.expiry?.isIdleExpired(record)) {
        expireIdle(record);
        continue;
      }
      result.push(record);
    }
    return result;
  };

  const closeEntry = (pairingId: string): void => {
    const entry = entries.get(pairingId);
    if (!entry) return;
    entries.delete(pairingId);
    for (const stop of entry.unsubscribe) stop();
    entry.bridge.closeAll();
    entry.link.close();
  };

  const closeAllEntries = (): void => {
    for (const id of [...entries.keys()]) closeEntry(id);
  };

  const openEntry = (record: RemotePairingRecord): void => {
    const relaySecret = options.getRelaySecret();
    if (!relaySecret) return;
    let link: RemoteRelayLink;
    const k = store.openPairingKey(record.id);
    try {
      link = options.createLink({
        role: 'host',
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
    // The link exists but nothing refers to it yet: if the bridge cannot be set up, it must not be left behind.
    const unsubscribe: Array<() => void> = [];
    let bridge: HostBridge | undefined;
    let entry: Entry;
    try {
      bridge = options.createBridge({ pairingId: record.id, name: record.peerName });
      entry = { link, bridge, connectedAt: null, unsubscribe };
      unsubscribe.push(bridge.attach(link));
      unsubscribe.push(
        link.on('session', (event) => {
          if (event.up) {
            entry.connectedAt = clock.now();
            store.markConnected(record.id);
            audit(record, { event: 'connect', target: 'link', result: 'ok' });
          } else {
            entry.connectedAt = null;
            bridge?.closeAll();
            audit(record, { event: 'disconnect', target: 'link', result: 'closed' });
          }
        }),
      );
    } catch (error) {
      for (const stop of unsubscribe) stop();
      bridge?.closeAll();
      link.close();
      throw error;
    }
    entries.set(record.id, entry);
    link.start();
  };

  /** Brings the open links in line with the active pairings; one unreadable pairing never blocks the others. */
  const syncLinks = (): void => {
    if (!enabled) return;
    const all = activePairings();
    // A suspension of a pairing that is gone (revoked, expired, deleted) is forgotten.
    const known = new Set(all.map((record) => record.id));
    for (const id of [...suspensions.keys()]) if (!known.has(id)) suspensions.delete(id);
    const active = all.filter((record) => !isSuspended(record.id));
    const activeIds = new Set(active.map((record) => record.id));
    for (const id of [...entries.keys()]) if (!activeIds.has(id)) closeEntry(id);
    for (const record of active) {
      if (entries.has(record.id)) continue;
      try {
        openEntry(record);
      } catch {
        // This pairing cannot connect now (key unreadable); it is listed as not connected.
      }
    }
  };

  // ---------------------------------------------------------------- auto-off tick

  const turnOff = (): void => {
    enabled = false;
    cancelTick?.();
    cancelTick = undefined;
    settings.set(KEY_ENABLED, '0');
    closeAllEntries();
  };

  const scheduleTick = (): void => {
    cancelTick?.();
    cancelTick = clock.setTimer(() => {
      cancelTick = undefined;
      if (!enabled) return;
      const deadline = autoOffAt();
      if (deadline !== null && clock.now() >= deadline) {
        turnOff();
        return;
      }
      syncLinks();
      scheduleTick();
    }, TICK_MS);
  };

  // ---------------------------------------------------------------- views

  const relayState = (active: RemotePairingRecord[]): string => {
    if (!enabled) return 'stopped';
    if (active.length === 0) return 'idle';
    const states = [...entries.values()].map((entry) => entry.link.status.state);
    if (states.includes('online')) return 'online';
    if (states.length === 0) return 'offline';
    return states.includes('connecting') ? 'connecting' : states[0];
  };

  const controllerView = (record: RemotePairingRecord): RemoteHostControllerView => {
    const entry = entries.get(record.id);
    const suspension = suspensionOf(record.id);
    return {
      pairingId: record.id,
      name: record.peerName,
      connected: entry?.link.sessionActive ?? false,
      connectedAt: entry?.connectedAt ?? record.lastConnectedAt,
      streams: entry?.bridge.activeStreams ?? 0,
      ...(suspension ? { suspendedUntil: suspension.untilWall } : {}),
    };
  };

  const status = (): RemoteHostStatusView => {
    syncLinks();
    const active = activePairings();
    return {
      acceptEnabled: enabled,
      autoOffHours: autoOffHours(),
      autoOffAt: autoOffAt(),
      relay: { state: relayState(active) },
      approvalTimeoutMs: options.approvalTimeoutMs(),
      controllers: active.map(controllerView),
    };
  };

  // ---------------------------------------------------------------- commands

  const requireHostPairing = (pairingId: string): RemotePairingRecord => {
    const record = store.getPairing(pairingId);
    if (!record || record.role !== 'host' || record.revokedAt !== null) throw notFound();
    return record;
  };

  const revoke = async (pairingId: string): Promise<{ ok: true; relayConfirmed: boolean }> => {
    const record = requireHostPairing(pairingId);
    closeEntry(pairingId);
    try {
      store.revokeHostPairing(pairingId);
    } catch (error) {
      // Revoking seals `{roomId, hostToken}` from K. A pairing whose K cannot be opened (a changed master key,
      // a corrupt row) would stay listed as active for ever, so it is deleted instead: nothing is left to ask the
      // relay to destroy, and the relay forgets a room nobody uses.
      const current = store.getPairing(pairingId);
      if (!current || current.revokedAt !== null) throw error;
      store.deletePairing(pairingId);
      audit(record, { event: 'revoke', target: 'host-initiated', result: 'ok', detail: { relayConfirmed: false } });
      return { ok: true, relayConfirmed: false };
    }
    let relayConfirmed = false;
    try {
      relayConfirmed = await options.pendingDestroy.destroyNow(pairingId);
    } catch {
      // The retrier still owes the DESTROY; the revoke itself is done.
    }
    audit(record, { event: 'revoke', target: 'host-initiated', result: 'ok', detail: { relayConfirmed } });
    return { ok: true, relayConfirmed };
  };

  return {
    status,
    syncLinks,

    /** Switches Accept on or off. On: validates, persists and opens the links. Off: closes everything. */
    setAccept(input: { enabled: boolean; autoOffHours?: number }): RemoteHostStatusView {
      if (!input.enabled) {
        if (enabled) turnOff();
        return status();
      }
      const hours = input.autoOffHours;
      if (hours !== undefined && (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0 || hours > MAX_AUTO_OFF_HOURS)) {
        throw badRequest(`autoOffHours must be a whole number from 0 to ${MAX_AUTO_OFF_HOURS}.`);
      }
      if (!options.isSupported()) {
        throw new AppError('Remote cannot run in this mode (platform mode).', { statusCode: 409, code: 'REMOTE_UNSUPPORTED_MODE' });
      }
      if (!options.getRelaySecret()) {
        throw new AppError('Save the relay URL and secret before switching Accept on.', { statusCode: 400, code: 'REMOTE_NOT_CONFIGURED' });
      }
      if (hours !== undefined) settings.set(KEY_AUTO_OFF_HOURS, String(hours));
      settings.set(KEY_ENABLED_AT, String(clock.now()));
      settings.set(KEY_ENABLED, '1');
      enabled = true;
      syncLinks();
      scheduleTick();
      return status();
    },

    /** Server start: switches Accept back on only if it was on and its auto-off deadline has not passed. */
    restore(): void {
      if (settings.get(KEY_ENABLED) !== '1') return;
      enabled = true;
      const deadline = autoOffAt();
      if ((deadline !== null && clock.now() >= deadline) || !options.isSupported() || !options.getRelaySecret()) {
        turnOff();
        return;
      }
      syncLinks();
      scheduleTick();
    },

    /** Ends that Controller's session now; a fresh link is offered at once so it can return while Accept is on. */
    disconnect(pairingId: string): void {
      const record = requireHostPairing(pairingId);
      closeEntry(pairingId);
      audit(record, { event: 'disconnect', target: 'host-initiated', result: 'closed' });
      if (!enabled || isSuspended(pairingId)) return; // a suspended Controller stays out until its time is up
      try {
        openEntry(record);
      } catch {
        // Offered again by the next sync.
      }
    },

    revoke,

    /**
     * Ends a Controller's link for repeated quota violations (FR-39) and keeps it from reconnecting for
     * `suspendMs` (the link is offered again by the next sync once the time has passed). The pairing itself
     * stays: the Host owner decides about revoking it.
     */
    suspend(pairingId: string, suspendMs: number): void {
      const record = store.getPairing(pairingId);
      if (!record || record.role !== 'host' || record.revokedAt !== null) return;
      suspensions.set(pairingId, { untilMonotonic: monotonicNow() + suspendMs, untilWall: clock.now() + suspendMs });
      closeEntry(pairingId);
      audit(record, { event: 'quota-disconnect', target: 'quota', result: 'closed', detail: { suspendSeconds: Math.round(suspendMs / 1000) } });
    },

    /** Expires every Host pairing that is idle past the limit (the periodic job); returns how many. */
    expireIdlePairings(): number {
      let expired = 0;
      for (const record of store.listPairings('host')) {
        if (!isActive(record) || !options.expiry?.isIdleExpired(record)) continue;
        if (expireIdle(record)) expired += 1;
      }
      return expired;
    },

    /**
     * Revokes every active Host pairing (relay URL or secret changed). The relay calls run side by side (an
     * unreachable relay costs its timeout once, not once per pairing); a pairing that cannot be revoked does
     * not stop the others, and the caller gets the counts.
     */
    async revokeAll(): Promise<{ revoked: number; failed: number }> {
      const results = await Promise.allSettled(activePairings().map((record) => revoke(record.id)));
      const failed = results.filter((result) => result.status === 'rejected').length;
      return { revoked: results.length - failed, failed };
    },

    /** Cuts every bridged stream but keeps the links (auth epoch change: the streams carried the old login). */
    closeStreams(): void {
      for (const entry of entries.values()) entry.bridge.closeAll();
    },

    /** Server shutdown: closes links and timers; the saved switch is left as it is for the next start. */
    stop(): void {
      cancelTick?.();
      cancelTick = undefined;
      closeAllEntries();
      enabled = false;
    },
  };
}

export type HostAcceptService = ReturnType<typeof createHostAcceptService>;
