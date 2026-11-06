/**
 * Tells the relay to destroy a Host pairing's room (revocation, contracts section 4), using only what a
 * revoked pairing still has: the room id and the host token (K is already erased). It is a standalone
 * relay client rather than a `RelayLink` because there is no K to run a link with.
 *
 * Flow: connect as `host` with the gate derived from `RELAY_SECRET`, authenticate with the host token,
 * wait for `ready`, send `{"t":"destroy"}` and wait for the relay to close with 4410. A room the relay
 * never saw is registered by this very connection (with a random `ctl`, which no Controller can match)
 * and destroyed at once, so a Controller holding K can never use it; a room that is already destroyed
 * answers 4410 straight away, which is also a confirmation.
 */

import crypto from 'node:crypto';

import type { RemoteClock, RemoteRelaySocketFactory } from '@/shared/types.js';

import { computeGate } from '../crypto/key-derivation.js';
import { createWsRelaySocketFactory } from '../link/relay-socket.js';
import { systemClock } from '../pairing/pairing-clock.js';

const RELAY_CLOSE_DESTROYED = 4410;
const DEFAULT_TIMEOUT_MS = 10_000;

export type DestroyRequest = {
  relayUrl: string;
  relaySecret: string;
  roomId: string;
  /** base64url host token derived from K before K was erased. */
  hostToken: string;
};

/** `confirmed`: the relay says the room is destroyed. `failed`: unreachable, refused or no answer in time (retry later). */
export type DestroyOutcome = 'confirmed' | 'failed';

export type RelayDestroyClientOptions = {
  socketFactory?: RemoteRelaySocketFactory;
  clock?: RemoteClock;
  timeoutMs?: number;
};

/**
 * Creates the DESTROY client.
 * Consumed by: Host accept (revoke) and the pending-destroy retrier.
 */
export function createRelayDestroyClient({ socketFactory = createWsRelaySocketFactory(), clock = systemClock, timeoutMs = DEFAULT_TIMEOUT_MS }: RelayDestroyClientOptions = {}) {
  return {
    destroy({ relayUrl, relaySecret, roomId, hostToken }: DestroyRequest): Promise<DestroyOutcome> {
      return new Promise<DestroyOutcome>((resolve) => {
        let settled = false;
        let cancelTimeout: () => void = () => undefined;
        const finish = (outcome: DestroyOutcome): void => {
          if (settled) return;
          settled = true;
          cancelTimeout();
          socket.close(1000); // silent when the socket already closed
          resolve(outcome);
        };
        const socket = socketFactory(
          { relayUrl, kind: 'link', room: roomId, role: 'host', gate: computeGate('link', roomId, relaySecret) },
          {
            // `ctl` is only read when this connection registers the room; random on purpose (see above).
            onOpen: () => socket.sendText(JSON.stringify({ t: 'auth', token: hostToken, ctl: crypto.randomBytes(32).toString('hex') })),
            onText: (text) => {
              let message: { t?: unknown } | null = null;
              try {
                message = JSON.parse(text) as { t?: unknown } | null;
              } catch {
                return;
              }
              if (typeof message === 'object' && message !== null && message.t === 'ready') socket.sendText('{"t":"destroy"}');
            },
            onBinary: () => undefined,
            onClose: (code) => finish(code === RELAY_CLOSE_DESTROYED ? 'confirmed' : 'failed'),
          },
        );
        cancelTimeout = clock.setTimer(() => finish('failed'), timeoutMs);
      });
    },
  };
}

export type RelayDestroyClient = ReturnType<typeof createRelayDestroyClient>;
