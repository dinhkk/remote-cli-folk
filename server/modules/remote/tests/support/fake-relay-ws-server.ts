/**
 * The in-process fake relay behind a real WebSocket server on 127.0.0.1: what the production
 * `ws` client talks to in tests. Upgrade refusals (gate, parameters, 503 ...) become real HTTP
 * responses, relay close codes become real close frames.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import type { FakeRelay } from './fake-relay.js';

export type FakeRelayWsServer = {
  /** `ws://127.0.0.1:<port>` */
  url: string;
  /** Number of upgrade requests seen (accepted or refused). */
  upgrades(): number;
  /** Cuts every client connection without telling the relay model first (a network drop). */
  dropClients(): void;
  close(): Promise<void>;
};

export type FakeRelayWsServerOptions = {
  /** Set false to model a peer that never answers WebSocket pings. */
  autoPong?: boolean;
};

export const startFakeRelayWsServer = async (relay: FakeRelay, { autoPong = true }: FakeRelayWsServerOptions = {}): Promise<FakeRelayWsServer> => {
  const server = http.createServer((request, response) => {
    const { status, body } = relay.httpStatus(request.url ?? '/');
    response.writeHead(status).end(body);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, autoPong });
  const clients = new Set<WebSocket>();
  let upgrades = 0;

  server.on('upgrade', (request, socket, head) => {
    upgrades += 1;
    const query = new URL(request.url ?? '/', 'http://relay.invalid').search.slice(1);
    const holder: { ws?: WebSocket } = {};
    const opened = relay.open(
      { kind: 'link', room: '', role: 'host', rawQuery: query, origin: request.headers.origin },
      {
        text: (data) => holder.ws?.send(data),
        binary: (data) => holder.ws?.send(data, { binary: true }),
        close: (code) => holder.ws?.close(code),
      },
    );
    if (!opened.socket) {
      socket.end(`HTTP/1.1 ${opened.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const relaySocket = opened.socket;
    wss.handleUpgrade(request, socket, head, (ws) => {
      holder.ws = ws;
      clients.add(ws);
      ws.on('message', (data, isBinary) => {
        if (isBinary) relaySocket.sendBinary(data as Buffer);
        else relaySocket.sendText(data.toString());
      });
      ws.on('close', (code) => {
        clients.delete(ws);
        relaySocket.close(code);
      });
      ws.on('error', () => undefined);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    upgrades: () => upgrades,
    dropClients: () => {
      for (const ws of clients) ws.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
