/**
 * One established E2E session of a relay link: the secure channel with fresh keys, the stream
 * table on top of it, the APP_HELLO exchange and (Controller side) the PING/PONG liveness check.
 *
 * A session is created right after a handshake succeeded and lives until the link ends it. It
 * never reconnects anything itself: when it cannot continue it calls `onFailed(reason)` once and
 * the link decides (reconnect, re-handshake, or just drop the session).
 *
 * Liveness (contracts section 5): the Controller sends PING every 15 s and expects any authentic
 * frame (normally PONG) within 10 s; otherwise the path to the Host is dead even if the relay
 * socket looks fine. The Host answers PING (at most `maxPingsPerSecond` per second: a flood is
 * dropped, not answered) and mirrors the check: no authentic frame for 40 s (two missed PINGs plus
 * slack) means the Controller is gone and the session is dropped.
 *
 * A connection-level `ERROR REMOTE_PROTOCOL` before the hello was accepted means a protocol version
 * mismatch; after it, the peer is declaring the session broken and it is torn down (`protocol-error`).
 * Stream-scoped errors never reach this file: the table closes just that stream.
 */

import type {
  RemoteClock,
  RemoteLinkReason,
  RemoteMuxLimits,
  RemoteMuxMeta,
  RemotePairingRole,
  RemoteSessionKeys,
} from '@/shared/types.js';

import { HANDSHAKE_TIMEOUT_MS } from '../crypto/handshake.js';
import { createSecureChannel } from '../crypto/secure-channel.js';
import { DEFAULT_MUX_LIMITS, createStreamTable, type StreamTable, type StreamTableOptions } from '../mux/stream-table.js';

export const PING_INTERVAL_MS = 15_000;
export const PONG_TIMEOUT_MS = 10_000;
/** Host side: no authentic frame from the Controller for this long ends the session (Controller PINGs every 15 s). */
export const HOST_IDLE_TIMEOUT_MS = 40_000;
const PING_WINDOW_MS = 1000;

export type LinkSessionOptions = {
  role: RemotePairingRole;
  keys: RemoteSessionKeys;
  /** Puts one encrypted frame on the relay socket (resolves once it left the process). */
  transmit(frame: Buffer): Promise<void> | void;
  clock: RemoteClock;
  limits?: Partial<RemoteMuxLimits>;
  appVersion: string;
  protocolVersion: number;
  onIncomingStream: StreamTableOptions['onIncomingStream'];
  /** The peer's APP_HELLO was accepted: streams may flow. */
  onEstablished(peerAppVersion: string): void;
  /** The session cannot continue (called at most once). */
  onFailed(reason: RemoteLinkReason): void;
  onHandlerError?(error: unknown): void;
};

export type LinkSession = {
  readonly table: StreamTable;
  /** True once the peer's APP_HELLO was accepted. */
  readonly established: boolean;
  readonly peerAppVersion: string | null;
  /** Feeds a DATA frame from the relay. Throws `ChannelDesync` when the channel lost sync. */
  receive(frame: Uint8Array): void;
  /** Ends the session: every stream gets `link-down(reason)`, timers stop, keys are wiped. */
  stop(reason: RemoteLinkReason): void;
};

// Consumed by: relay-link (one session per successful handshake).
export const createLinkSession = (options: LinkSessionOptions): LinkSession => {
  const { role, clock, appVersion, protocolVersion } = options;
  const channel = createSecureChannel({
    sendKey: options.keys.sendKey,
    receiveKey: options.keys.receiveKey,
    transmit: options.transmit,
  });
  let stopped = false;
  let failed = false;
  let helloRejected = false;
  let established = false;
  let peerAppVersion: string | null = null;
  let cancelHelloTimer: (() => void) | undefined;
  let cancelPing: (() => void) | undefined;
  let cancelPong: (() => void) | undefined;
  let cancelIdleCheck: (() => void) | undefined;
  let lastTrafficAt = clock.now();
  let pingWindowStart = Number.NEGATIVE_INFINITY;
  let pingsInWindow = 0;
  const { maxPingsPerSecond } = { ...DEFAULT_MUX_LIMITS, ...options.limits };

  const fail = (reason: RemoteLinkReason): void => {
    if (stopped || failed) return;
    failed = true;
    options.onFailed(reason);
  };

  const sendPing = (): void => {
    cancelPing = undefined;
    table.sendConnectionFrame('PING', {});
    cancelPong = clock.setTimer(() => {
      cancelPong = undefined;
      fail('liveness-timeout');
    }, PONG_TIMEOUT_MS);
  };

  const schedulePing = (): void => {
    cancelPing?.();
    cancelPing = clock.setTimer(sendPing, PING_INTERVAL_MS);
  };

  /** Host: one timer for the whole session; it re-arms for the time left when traffic arrived meanwhile. */
  const armIdleCheck = (delayMs: number): void => {
    cancelIdleCheck = clock.setTimer(() => {
      cancelIdleCheck = undefined;
      const idleMs = clock.now() - lastTrafficAt;
      if (idleMs >= HOST_IDLE_TIMEOUT_MS) fail('liveness-timeout');
      else armIdleCheck(HOST_IDLE_TIMEOUT_MS - idleMs);
    }, delayMs);
  };

  /** True while this second still has room for another PING answer. */
  const allowPing = (): boolean => {
    const now = clock.now();
    if (now - pingWindowStart >= PING_WINDOW_MS) {
      pingWindowStart = now;
      pingsInWindow = 0;
    }
    pingsInWindow += 1;
    return pingsInWindow <= maxPingsPerSecond;
  };

  /** Any authentic frame proves the path works: it answers an outstanding PING. */
  const sawTraffic = (): void => {
    lastTrafficAt = clock.now();
    if (!cancelPong) return;
    cancelPong();
    cancelPong = undefined;
    schedulePing();
  };

  /** Wrong role or protocol version: tell the peer (REMOTE_PROTOCOL), let the ERROR leave, then fail. */
  const rejectHello = (): void => {
    helloRejected = true;
    table.sendConnectionFrame('ERROR', { code: 'REMOTE_PROTOCOL', message: 'Protocol version mismatch.' });
    void table.drain().then(() => fail('protocol-mismatch'));
  };

  const handleHello = (meta: RemoteMuxMeta['APP_HELLO']): void => {
    if (established || helloRejected) return;
    if (meta.role === role || meta.protocolVersion !== protocolVersion) {
      rejectHello();
      return;
    }
    established = true;
    peerAppVersion = meta.appVersion;
    cancelHelloTimer?.();
    cancelHelloTimer = undefined;
    table.acceptStreams(true);
    if (role === 'controller') schedulePing();
    else armIdleCheck(HOST_IDLE_TIMEOUT_MS);
    lastTrafficAt = clock.now();
    options.onEstablished(meta.appVersion);
  };

  const table = createStreamTable({
    role,
    clock,
    limits: options.limits,
    transmit: (plaintext) => channel.send(plaintext),
    onIncomingStream: options.onIncomingStream,
    onConnectionFrame: (frame) => {
      if (frame.type === 'PING') {
        if (allowPing()) table.sendConnectionFrame('PONG', {});
      } else if (frame.type === 'APP_HELLO') {
        handleHello(frame.meta);
      } else if (frame.type === 'ERROR' && frame.meta.code === 'REMOTE_PROTOCOL') {
        if (established) {
          fail('protocol-error');
        } else {
          helloRejected = true;
          fail('protocol-mismatch');
        }
      }
    },
    onTransmitError: () => fail('transmit-failed'),
    onLinkQuotaExceeded: () => fail('quota-exceeded'),
    onHandlerError: options.onHandlerError,
  });

  // Streams are refused until the peer's hello was accepted; our own hello goes out first.
  table.acceptStreams(false);
  cancelHelloTimer = clock.setTimer(() => {
    cancelHelloTimer = undefined;
    fail('handshake-timeout');
  }, HANDSHAKE_TIMEOUT_MS);
  table.sendConnectionFrame('APP_HELLO', { protocolVersion, appVersion, role });

  return {
    table,
    get established() {
      return established;
    },
    get peerAppVersion() {
      return peerAppVersion;
    },

    receive(frame) {
      if (stopped || failed) return;
      const plaintext = channel.receive(frame);
      if (plaintext === undefined) return;
      sawTraffic();
      table.receive(plaintext);
    },

    stop(reason) {
      if (stopped) return;
      stopped = true;
      cancelHelloTimer?.();
      cancelPing?.();
      cancelPong?.();
      cancelIdleCheck?.();
      cancelHelloTimer = cancelPing = cancelPong = cancelIdleCheck = undefined;
      table.closeAll(reason);
      channel.close();
    },
  };
};
