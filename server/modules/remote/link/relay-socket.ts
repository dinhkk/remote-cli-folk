/**
 * The real relay WebSocket (contracts section 4): the `ws` client behind `RemoteRelaySocketFactory`.
 *
 * Builds `wss://<relay>/ws?kind=&room=&role=&gate=`, reports an upgrade the relay refused as
 * `onClose(0, httpStatus)`, and keeps its own transport-level liveness: a WebSocket ping every 25 s
 * with 10 s to answer, otherwise the socket is terminated (`onClose(1006)`) so the link reconnects
 * instead of waiting for TCP to notice. A socket the owner closed stays silent afterwards.
 */

import { WebSocket } from 'ws';

import type { RemoteClock, RemoteRelaySocketFactory } from '@/shared/types.js';

import { MAX_FRAME_BYTES } from '../crypto/secure-channel.js';
import { systemClock } from '../pairing/pairing-clock.js';

export const WS_PING_INTERVAL_MS = 25_000;
export const WS_PONG_TIMEOUT_MS = 10_000;
const UPGRADE_TIMEOUT_MS = 10_000;
/** Reported to the owner when one of its callbacks threw while handling a relay event. */
const PROTOCOL_ERROR_CLOSE = 1002;

// Consumed by: relay-link (default socket factory) and pair-connector (pairing room sockets).
export const createWsRelaySocketFactory =
  ({ clock = systemClock }: { clock?: RemoteClock } = {}): RemoteRelaySocketFactory =>
  (target, handlers) => {
    const url = new URL('/ws', target.relayUrl);
    url.searchParams.set('kind', target.kind);
    url.searchParams.set('room', target.room);
    url.searchParams.set('role', target.role);
    url.searchParams.set('gate', target.gate);

    // The relay carries only encrypted frames; compression would waste CPU and gains nothing.
    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: UPGRADE_TIMEOUT_MS,
      followRedirects: false,
    });
    // Messages arrive as one Buffer each (the default), never as fragment lists or ArrayBuffers.
    ws.binaryType = 'nodebuffer';
    let finished = false;
    let cancelPing: (() => void) | undefined;
    let cancelPong: (() => void) | undefined;

    const stopKeepAlive = (): void => {
      cancelPing?.();
      cancelPong?.();
      cancelPing = cancelPong = undefined;
    };

    const schedulePing = (): void => {
      cancelPing = clock.setTimer(() => {
        cancelPing = undefined;
        ws.ping();
        cancelPong = clock.setTimer(() => {
          cancelPong = undefined;
          ws.terminate();
        }, WS_PONG_TIMEOUT_MS);
      }, WS_PING_INTERVAL_MS);
    };

    const finish = (code: number, httpStatus?: number): void => {
      if (finished) return;
      finished = true;
      stopKeepAlive();
      try {
        handlers.onClose(code, httpStatus);
      } catch {
        // The owner is gone either way; a throwing close handler must not become an uncaught exception.
      }
    };

    /**
     * Runs a consumer callback from a socket event. A throw would otherwise be an uncaught exception
     * out of the `ws` listener (the whole server would die): the socket is closed with 1002 instead and
     * the owner is told through `onClose`, like any other broken connection.
     */
    const guarded = (callback: () => void): void => {
      if (finished) return;
      try {
        callback();
      } catch {
        finish(PROTOCOL_ERROR_CLOSE);
        ws.terminate();
      }
    };

    ws.on('open', () => {
      if (finished) return;
      schedulePing();
      guarded(() => handlers.onOpen());
    });
    ws.on('message', (data, isBinary) => {
      if (finished) return;
      if (isBinary) guarded(() => handlers.onBinary(data as Buffer));
      else guarded(() => handlers.onText((data as Buffer).toString('utf8')));
    });
    ws.on('pong', () => {
      if (finished || !cancelPong) return;
      cancelPong();
      cancelPong = undefined;
      schedulePing();
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(0, response.statusCode);
      ws.terminate();
    });
    // 'error' is always followed by 'close'; the listener only keeps it from becoming an uncaught exception.
    ws.on('error', () => undefined);
    ws.on('close', (code) => finish(code));

    return {
      sendText(text) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      sendBinary(data) {
        return new Promise<void>((resolve, reject) => {
          if (ws.readyState !== WebSocket.OPEN) {
            reject(new Error('Relay socket is not open.'));
            return;
          }
          ws.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
        });
      },
      close(code = 1000) {
        if (finished) return;
        finished = true;
        stopKeepAlive();
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(code);
      },
    };
  };
