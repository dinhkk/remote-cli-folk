/**
 * A hand-driven Host peer on the in-process relay: authenticates to the link room, answers
 * handshakes with the real crypto and then lets a test put arbitrary connection-level frames on the
 * encrypted channel (what a buggy or hostile Host could do) and read what the Controller sent.
 */

import crypto from 'node:crypto';

import type { RemoteMuxFrame, RemoteRelaySocket } from '@/shared/types.js';

import { createHostHandshakeListener, type HostPendingHandshake } from '../../crypto/handshake.js';
import { computeGate, deriveLinkKeys } from '../../crypto/key-derivation.js';
import { createSecureChannel, type SecureChannel } from '../../crypto/secure-channel.js';
import { decodeFrame, encodeFrame } from '../../mux/frames.js';

import { RELAY_SECRET, RELAY_URL, type LinkRig } from './relay-link-rig.js';

const EMPTY = Buffer.alloc(0);

export type ScriptedHost = {
  /** Frames the Controller sent over the current session, decoded. */
  readonly received: RemoteMuxFrame[];
  /** Completed handshakes (a re-handshake adds one). */
  readonly sessions: number;
  /** Puts one mux frame on the current session; throws when no session exists. */
  send(frame: RemoteMuxFrame): void;
  close(): void;
};

export const startScriptedHost = (rig: LinkRig): ScriptedHost => {
  const keys = deriveLinkKeys(rig.k);
  const listener = createHostHandshakeListener({ k: rig.k, now: () => rig.clock.now() });
  const state = { sessions: 0, pending: undefined as HostPendingHandshake | undefined, channel: undefined as SecureChannel | undefined };
  const received: RemoteMuxFrame[] = [];
  const holder: { socket?: RemoteRelaySocket } = {};

  const send = (frame: RemoteMuxFrame): void => {
    if (!state.channel) throw new Error('no session');
    void state.channel.send(encodeFrame(frame));
  };

  holder.socket = rig.net.factory(
    { relayUrl: RELAY_URL, kind: 'link', room: keys.roomId, role: 'host', gate: computeGate('link', keys.roomId, RELAY_SECRET) },
    {
      onOpen: () =>
        holder.socket?.sendText(
          JSON.stringify({ t: 'auth', token: keys.hostToken, ctl: crypto.createHash('sha256').update(keys.controllerToken, 'utf8').digest('hex') }),
        ),
      onText: () => undefined,
      onBinary: (data) => {
        if (data[0] === 1) {
          state.pending = listener.acceptHello1(data);
          void holder.socket?.sendBinary(state.pending.hello2);
        } else if (data[0] === 3 && state.pending) {
          const sessionKeys = state.pending.completeWithHello3(data);
          state.pending = undefined;
          state.channel?.close();
          const socket = holder.socket as RemoteRelaySocket;
          state.channel = createSecureChannel({ sendKey: sessionKeys.sendKey, receiveKey: sessionKeys.receiveKey, transmit: (frame) => socket.sendBinary(frame) });
          state.sessions += 1;
          send({ type: 'APP_HELLO', streamId: 0, meta: { protocolVersion: 1, appVersion: 'scripted-host', role: 'host' }, body: EMPTY });
        } else if (data[0] === 0x10 && state.channel) {
          const plaintext = state.channel.receive(data);
          if (plaintext) received.push(decodeFrame(plaintext));
        }
      },
      onClose: () => undefined,
    },
  );

  return {
    received,
    get sessions() {
      return state.sessions;
    },
    send,
    close: () => holder.socket?.close(1000),
  };
};
