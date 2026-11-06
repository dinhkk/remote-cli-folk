/**
 * The link handshake of one role on one relay socket (contracts section 5).
 *
 * Controller: `beginController` sends HELLO1 (whenever the relay reports `peer up:true`) and gives up
 * on HELLO2 after 10 s. Host: answers every HELLO1 with HELLO2 but only hands out session keys once
 * HELLO3 authenticates, so an unauthenticated HELLO1 cannot knock a live session out. Every
 * handshake derives fresh session keys. A rejected handshake message is reported and changes
 * nothing: the handshake window keeps running.
 */

import type { RemoteClock, RemotePairingRole, RemoteSessionKeys } from '@/shared/types.js';

import {
  HANDSHAKE_TIMEOUT_MS,
  HandshakeError,
  createControllerHandshake,
  createHostHandshakeListener,
  type ControllerHandshake,
  type HostHandshakeListener,
  type HostPendingHandshake,
} from '../crypto/handshake.js';

const TYPE_HELLO1 = 1;
const TYPE_HELLO2 = 2;
const TYPE_HELLO3 = 3;

export type LinkHandshakeOptions = {
  role: RemotePairingRole;
  /** The pairing key K (the caller owns and wipes it). */
  k: Uint8Array;
  clock: RemoteClock;
  /** Puts a binary handshake frame on the relay socket. */
  sendRaw(data: Uint8Array): void;
  /** Socket generation; a timer that outlives its socket is ignored. */
  generation(): number;
  /** A handshake completed: start the session with these keys. */
  onKeys(keys: RemoteSessionKeys): void;
  /** Controller: HELLO2 never arrived within 10 s. */
  onTimeout(): void;
  /** A handshake message was rejected (diagnostics). */
  onError(code: string): void;
};

export type LinkHandshake = {
  /** Controller: sends a fresh HELLO1 and starts the 10 s window; supersedes any handshake in progress. */
  beginController(): void;
  /** Routes a binary relay frame of the handshake range (HELLO1/2/3) by role; other types are ignored. */
  receive(type: number, data: Uint8Array): void;
  /** Drops the handshake in progress and its timer. */
  cancel(): void;
};

// Consumed by: relay-link (one handshake driver per link).
export const createLinkHandshake = (options: LinkHandshakeOptions): LinkHandshake => {
  const { role, clock } = options;
  const hostListener: HostHandshakeListener | undefined =
    role === 'host' ? createHostHandshakeListener({ k: options.k, now: () => clock.now() }) : undefined;
  let controllerPending: ControllerHandshake | undefined;
  let hostPending: HostPendingHandshake | undefined;
  let cancelTimer: (() => void) | undefined;

  const cancel = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    controllerPending = undefined;
    hostPending = undefined;
  };

  const reportError = (error: unknown): void => options.onError(error instanceof HandshakeError ? error.code : 'invalid');

  const onHello2 = (data: Uint8Array): void => {
    const pending = controllerPending;
    if (!pending) return;
    let completed: ReturnType<ControllerHandshake['completeWithHello2']>;
    try {
      completed = pending.completeWithHello2(data);
    } catch (error) {
      // Not fatal: a forged or stale HELLO2 changes nothing, the handshake window keeps running.
      reportError(error);
      return;
    }
    cancelTimer?.();
    cancelTimer = undefined;
    controllerPending = undefined;
    options.sendRaw(completed.hello3);
    options.onKeys(completed.keys);
  };

  const onHello1 = (data: Uint8Array): void => {
    let pending: HostPendingHandshake;
    try {
      pending = (hostListener as HostHandshakeListener).acceptHello1(data);
    } catch (error) {
      reportError(error);
      return;
    }
    cancelTimer?.();
    hostPending = pending;
    options.sendRaw(pending.hello2);
    cancelTimer = clock.setTimer(() => {
      cancelTimer = undefined;
      if (hostPending === pending) hostPending = undefined;
    }, HANDSHAKE_TIMEOUT_MS);
  };

  const onHello3 = (data: Uint8Array): void => {
    const pending = hostPending;
    if (!pending) return;
    let keys: RemoteSessionKeys;
    try {
      keys = pending.completeWithHello3(data);
    } catch (error) {
      reportError(error);
      return;
    }
    cancelTimer?.();
    cancelTimer = undefined;
    hostPending = undefined;
    // The Controller proved it holds K: only now may the previous session be replaced.
    options.onKeys(keys);
  };

  return {
    beginController() {
      cancel();
      const pending = createControllerHandshake({ k: options.k, now: () => clock.now() });
      controllerPending = pending;
      options.sendRaw(pending.hello1);
      const forGeneration = options.generation();
      cancelTimer = clock.setTimer(() => {
        cancelTimer = undefined;
        if (forGeneration === options.generation() && controllerPending === pending) options.onTimeout();
      }, HANDSHAKE_TIMEOUT_MS);
    },

    receive(type, data) {
      if (role === 'controller' && type === TYPE_HELLO2) onHello2(data);
      else if (role === 'host' && type === TYPE_HELLO1) onHello1(data);
      else if (role === 'host' && type === TYPE_HELLO3) onHello3(data);
    },

    cancel,
  };
};
