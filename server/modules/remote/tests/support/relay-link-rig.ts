/**
 * Test rig for relay links: an in-process socket factory over the fake relay (no sockets, a
 * virtual clock shared with the relay) plus helpers to build Host/Controller links, observe their
 * events and tamper with the frames that cross the relay.
 */

import crypto from 'node:crypto';

import type {
  RemoteLinkEvents,
  RemoteLinkStatus,
  RemotePairingRole,
  RemoteRelayLink,
  RemoteRelaySocket,
  RemoteRelaySocketFactory,
  RemoteRelaySocketHandlers,
  RemoteRelaySocketTarget,
} from '@/shared/types.js';

import { createRelayLink, type RelayLinkOptions } from '../../link/relay-link.js';

import { FakeRelay } from './fake-relay.js';
import { createManualClock, type ManualClock } from './manual-clock.js';

export const RELAY_SECRET = 'test-relay-secret';
export const RELAY_URL = 'wss://fake-relay.test';

/** Hooks to observe or tamper with binary frames crossing the relay. Return false to swallow a frame. */
export type LinkTap = {
  /** A role sent a frame toward the relay. */
  onSend?(role: RemotePairingRole, data: Uint8Array): boolean | void;
  /** The relay delivers a frame to a role. */
  onReceive?(role: RemotePairingRole, data: Uint8Array): boolean | void;
};

export type WireRecord = { from: RemotePairingRole; type: number; length: number; counter: bigint | null; data: Uint8Array };

export type SocketRecord = {
  role: RemotePairingRole;
  target: RemoteRelaySocketTarget;
  handlers: RemoteRelaySocketHandlers;
  socket: RemoteRelaySocket | null;
  /** Close code the link requested, or undefined while the link has not closed it. */
  closedByLink: number | undefined;
  /** HTTP status when the relay refused the upgrade. */
  refusedWith: number | undefined;
  texts: string[];
};

export type InProcessNetwork = {
  factory: RemoteRelaySocketFactory;
  sockets: SocketRecord[];
  /** Binary frames in the order the links sent them. */
  wire: WireRecord[];
  /** While down, new sockets fail at once with 1006 (relay unreachable). */
  setNetworkDown(down: boolean): void;
  /** Closes a role's live socket from the network side: the relay sees the close, the link gets `onClose(code)`. */
  sever(role: RemotePairingRole, code?: number): void;
  tap: LinkTap;
};

export const createInProcessNetwork = (relay: FakeRelay, tap: LinkTap = {}): InProcessNetwork => {
  const sockets: SocketRecord[] = [];
  const wire: WireRecord[] = [];
  let down = false;

  const factory: RemoteRelaySocketFactory = (target, handlers) => {
    const record: SocketRecord = { role: target.role, target, handlers, socket: null, closedByLink: undefined, refusedWith: undefined, texts: [] };
    sockets.push(record);
    const closedSocket: RemoteRelaySocket = { sendText: () => undefined, sendBinary: () => undefined, close: () => undefined };
    if (down) {
      queueMicrotask(() => handlers.onClose(1006));
      return closedSocket;
    }
    let detached = false;
    const opened = relay.open(
      { kind: target.kind, room: target.room, role: target.role, gate: target.gate },
      {
        text: (data) => {
          if (!detached) handlers.onText(data);
        },
        binary: (data) => {
          if (detached) return;
          if (tap.onReceive?.(target.role, data) === false) return;
          handlers.onBinary(data);
        },
        close: (code) => {
          if (detached) return;
          detached = true;
          handlers.onClose(code);
        },
      },
    );
    if (!opened.socket) {
      record.refusedWith = opened.status;
      queueMicrotask(() => handlers.onClose(0, opened.status));
      return closedSocket;
    }
    const relaySocket = opened.socket;
    queueMicrotask(() => {
      if (!detached) handlers.onOpen();
    });
    record.socket = {
      sendText(text) {
        record.texts.push(text);
        if (!detached) relaySocket.sendText(text);
      },
      sendBinary(data) {
        const bytes = Uint8Array.from(data);
        wire.push({
          from: target.role,
          type: bytes[0],
          length: bytes.length,
          counter: bytes[0] === 0x10 && bytes.length >= 9 ? Buffer.from(bytes).readBigUInt64BE(1) : null,
          data: bytes,
        });
        if (tap.onSend?.(target.role, bytes) === false) return;
        if (!detached) relaySocket.sendBinary(bytes);
      },
      close(code) {
        record.closedByLink = code ?? 1000;
        if (detached) return;
        detached = true; // a socket the owner closed stays silent, like the real adapter
        relaySocket.close(code ?? 1000);
      },
    };
    return record.socket;
  };

  return {
    factory,
    sockets,
    wire,
    tap,
    setNetworkDown: (value) => {
      down = value;
    },
    sever(role, code = 1006) {
      const live = [...sockets].reverse().find((candidate) => candidate.role === role && candidate.closedByLink === undefined && candidate.socket);
      if (!live) throw new Error(`no live ${role} socket`);
      live.closedByLink = code;
      live.socket?.close(1000);
      live.handlers.onClose(code);
    },
  };
};

/** Collects a link's events for assertions. */
export const watchLink = (link: RemoteRelayLink) => {
  const states: RemoteLinkStatus[] = [];
  const sessions: Array<RemoteLinkEvents['session']> = [];
  const peers: boolean[] = [];
  const desyncs: Array<RemoteLinkEvents['desync']> = [];
  const handshakeErrors: string[] = [];
  link.on('state', (status) => states.push(status));
  link.on('session', (event) => sessions.push(event));
  link.on('peer', (event) => peers.push(event.up));
  link.on('desync', (event) => desyncs.push(event));
  link.on('handshake-error', (event) => handshakeErrors.push(event.code));
  return { states, sessions, peers, desyncs, handshakeErrors };
};

export type LinkRig = {
  relay: FakeRelay;
  clock: ManualClock;
  net: InProcessNetwork;
  k: Buffer;
  createLink(role: RemotePairingRole, extra?: Partial<RelayLinkOptions>): RemoteRelayLink;
  /** Lets every pending delivery and its reactions run. */
  settle(): Promise<void>;
  /** Moves the shared virtual clock in steps of at most `stepMs` (and 1 s), settling between steps so replies are seen. */
  advance(ms: number, stepMs?: number): Promise<void>;
  /** Closes every link created through the rig. */
  dispose(): void;
};

export const createLinkRig = (tap: LinkTap = {}, k: Buffer = crypto.randomBytes(32)): LinkRig => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  // The relay's virtual time is moved by `advance` after the links reacted: sockets opened by a timer
  // must be able to authenticate before the relay's own 5 s auth deadline moves past them.
  const clock = createManualClock(relay.now());
  const net = createInProcessNetwork(relay, tap);
  const links: RemoteRelayLink[] = [];

  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await relay.flush();
  };

  return {
    relay,
    clock,
    net,
    k,
    createLink(role, extra = {}) {
      const link = createRelayLink({
        role,
        k,
        relayUrl: RELAY_URL,
        relaySecret: RELAY_SECRET,
        appVersion: `${role}-1.0`,
        socketFactory: net.factory,
        clock,
        ...extra,
      });
      links.push(link);
      return link;
    },
    settle,
    async advance(ms, stepMs = 1000) {
      // Never more than 1 s at a time: replies (PONG, HELLO2, relay notices) must be processed between timers.
      const maxStep = Math.min(stepMs, 1000);
      let left = ms;
      while (left > 0) {
        const step = Math.min(maxStep, left);
        clock.advance(step);
        await settle();
        relay.advance(step);
        await settle();
        left -= step;
      }
    },
    dispose() {
      for (const link of links) link.close();
    },
  };
};

/** Polls until `condition` holds (real time; for tests that run links on the system clock or real sockets). */
export const waitFor = async (condition: () => boolean, description: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};
