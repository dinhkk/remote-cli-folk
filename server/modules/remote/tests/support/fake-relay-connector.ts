/**
 * `RemotePairConnector` over the in-process fake relay: what the real relay link will be in
 * production, minus the network. Opens a `pair` room socket with the valid gate, sends the auth
 * frame with the pair token and translates relay events into the connector callbacks.
 */

import type { RemotePairChannel, RemotePairChannelHandlers, RemotePairConnector } from '@/shared/types.js';

import type { FakeRelay } from './fake-relay.js';

/** Hooks tests use to observe or tamper with a connection (all optional). */
export type FakeConnectorTap = {
  /** Called for every frame a channel sends; return false to swallow it. */
  onSend?(role: 'host' | 'controller', frame: Uint8Array): boolean | void;
};

export const createFakeRelayConnector = (relay: FakeRelay, tap: FakeConnectorTap = {}): RemotePairConnector =>
  ({ roomId, pairToken, role }, handlers: RemotePairChannelHandlers): RemotePairChannel => {
    let closed = false;
    const opened = relay.open(
      { kind: 'pair', room: roomId, role },
      {
        text: (data) => {
          if (closed) return;
          const message = JSON.parse(data) as { t: string; up?: boolean };
          if (message.t === 'ready') handlers.onReady();
          else if (message.t === 'peer') handlers.onPeer(Boolean(message.up));
        },
        binary: (data) => {
          if (!closed) handlers.onFrame(data);
        },
        close: (code) => {
          if (closed) return;
          closed = true;
          handlers.onClose(code);
        },
      },
    );

    if (!opened.socket) {
      closed = true;
      queueMicrotask(() => handlers.onClose(0));
      return { sendFrame: () => undefined, sendDestroy: () => undefined, close: () => undefined };
    }

    const { socket } = opened;
    socket.sendText(JSON.stringify({ t: 'auth', token: pairToken }));
    return {
      sendFrame(frame) {
        if (closed) return;
        if (tap.onSend?.(role, frame) === false) return;
        socket.sendBinary(frame);
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
