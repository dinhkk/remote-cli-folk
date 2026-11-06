/**
 * The real `RemotePairConnector` for the pairing ceremony: opens a `pair` room socket on the relay
 * with the gate derived from `RELAY_SECRET`, authenticates with the code-derived pair token and
 * translates relay events (`ready`, `peer`, binary frames, close) into the ceremony's callbacks.
 */

import type { RemotePairChannel, RemotePairConnector, RemoteRelaySocketFactory } from '@/shared/types.js';

import { computeGate } from '../crypto/key-derivation.js';

import { createWsRelaySocketFactory } from './relay-socket.js';

/**
 * An upgrade the relay refused before the WebSocket existed: 401 (wrong `RELAY_SECRET` gate), 403
 * (origin) and 503 (relay not configured or its secret too weak). They are reported like the
 * relay's own 4401 so the user is told to fix the relay settings instead of retrying blindly.
 */
const REFUSED_HTTP_STATUSES = new Set([401, 403, 503]);
const RELAY_CLOSE_REJECTED = 4401;

export type PairConnectorOptions = {
  relayUrl: string;
  relaySecret: string;
  /** Defaults to the real `ws` client; tests substitute an in-process fake relay. */
  socketFactory?: RemoteRelaySocketFactory;
};

// Consumed by: the pairing services (phase 08 wires them to the management API).
export const createRelayPairConnector =
  ({ relayUrl, relaySecret, socketFactory = createWsRelaySocketFactory() }: PairConnectorOptions): RemotePairConnector =>
  ({ roomId, pairToken, role }, handlers): RemotePairChannel => {
    let closed = false;
    const socket = socketFactory(
      { relayUrl, kind: 'pair', room: roomId, role, gate: computeGate('pair', roomId, relaySecret) },
      {
        // The factory never calls these before it returned, so `socket` is assigned by then.
        onOpen: () => socket.sendText(JSON.stringify({ t: 'auth', token: pairToken })),
        onText: (text) => {
          if (closed) return;
          let message: { t?: unknown; up?: unknown } | null;
          try {
            message = JSON.parse(text) as typeof message;
          } catch {
            return;
          }
          // `null`, strings, numbers and arrays are valid JSON too; only an object can carry a message.
          if (typeof message !== 'object' || message === null) return;
          if (message.t === 'ready') handlers.onReady();
          else if (message.t === 'peer') handlers.onPeer(message.up === true);
        },
        onBinary: (data) => {
          if (!closed) handlers.onFrame(data);
        },
        onClose: (code, httpStatus) => {
          if (closed) return;
          closed = true;
          handlers.onClose(httpStatus !== undefined && REFUSED_HTTP_STATUSES.has(httpStatus) ? RELAY_CLOSE_REJECTED : code);
        },
      },
    );

    return {
      sendFrame(frame) {
        if (closed) return;
        // A failed send surfaces as the socket closing; nothing else to do with the rejection.
        Promise.resolve(socket.sendBinary(frame)).catch(() => undefined);
      },
      sendDestroy() {
        if (!closed) socket.sendText('{"t":"destroy"}');
      },
      close() {
        if (closed) return;
        closed = true;
        socket.close(1000);
      },
    };
  };
