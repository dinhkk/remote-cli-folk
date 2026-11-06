/**
 * Test rig for the Remote WebSocket gateway: the REAL `createWebSocketServer` on a loopback HTTP server,
 * the real auth functions and a throwaway database, a scripted link behind a real peer registry, and
 * helpers to open browser-side sockets (regular JWT sockets on `/desktop-notifications`, tab sockets on
 * `/r/<peerId>/(ws|shell)`).
 */

import { WebSocket, type WebSocketServer } from 'ws';

import { authenticateWebSocket, issueTabToken, onAuthEpochChange } from '@/modules/auth/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';

import { createRemoteWebSocketGateway } from '../../controller/controller-ws-proxy.service.js';
import { createPeerRegistry, type PeerRegistry } from '../../controller/peer-registry.service.js';
import { createReceiveLedger, resolveReceiveBudgets, type ReceiveBudgets } from '../../controller/receive-budget.js';
import { createTabTokenService } from '../../controller/tab-token.service.js';

import { createTestAccount, logoutEverywhere } from './auth-test-session.js';
import { createFakeLink, type FakeLink, type FakeStream } from './fake-link.js';
import { serve, type RunningServer } from './http-test-client.js';
import { createManualClock, type ManualClock } from './manual-clock.js';
import { createMemoryPairingStore } from './memory-pairing-store.js';
import { withTempDatabase } from './temp-database.js';

export type GatewayHarness = {
  port: number;
  wss: WebSocketServer;
  link: FakeLink;
  peerId: string;
  otherPeerId: string;
  tabToken: string;
  mainJwt: string;
  clock: ManualClock;
  /** The real "log out everywhere" of the account (bumps the auth epoch, rotates the JWT secret). */
  logoutAll(): Promise<number>;
  registry: PeerRegistry;
  issueFor(peerId: string): string;
  /** Opens a browser socket to `/r/<peerId>/<channel>` offering `['cloudcli-tab', token]` and waits for the verdict. */
  openTab(options?: { channel?: 'ws' | 'shell'; peerId?: string; token?: string; protocols?: string[]; query?: string }): Promise<WebSocket>;
  /** Opens a regular socket the way the Local UI does (`?token=`). */
  openRegular(token?: string): Promise<WebSocket>;
  /** Resolves the HTTP status of an upgrade that was refused. */
  refusal(path: string, protocols?: string[]): Promise<number>;
  nextStream(index?: number): Promise<FakeStream>;
};

export const waitFor = async (condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

export type GatewayHarnessOptions = {
  online?: boolean;
  shellMinIntervalMs?: number;
  shellMaxPending?: number;
  receiveBudgetBytes?: number;
  receiveBudgets?: Partial<ReceiveBudgets>;
  /** Expiry (epoch ms) of the first pairing. */
  peerExpiresAt?: number;
};

export const withGatewayHarness = async (options: GatewayHarnessOptions, run: (harness: GatewayHarness) => Promise<void>): Promise<void> =>
  withTempDatabase(async () => {
    const user = await createTestAccount('alice');
    const clock = createManualClock(Date.now());
    const store = createMemoryPairingStore(clock.now);
    const peer = store.add({ role: 'controller', name: 'Host', expiresAt: options.peerExpiresAt ?? null });
    const other = store.add({ role: 'controller', name: 'Other' });
    const link = createFakeLink('controller');
    if (options.online !== false) {
      link.setStatus({ state: 'online', peerState: 'online' });
      link.setSession(true);
    }
    const registry = createPeerRegistry({
      store,
      getRelaySecret: () => 's'.repeat(32),
      isSupported: () => true,
      clock,
      appVersion: 'test',
      createLink: () => link,
    });
    const tabs = createTabTokenService({ hasPeer: registry.hasPeer, isExpired: registry.isExpired });
    const gateway = createRemoteWebSocketGateway({
      tabs,
      registry,
      shellMinIntervalMs: options.shellMinIntervalMs,
      shellMaxPending: options.shellMaxPending,
      receiveBudgetBytes: options.receiveBudgetBytes,
      receiveLedger: options.receiveBudgets ? createReceiveLedger(resolveReceiveBudgets({}, options.receiveBudgets)) : undefined,
    });

    const server: RunningServer = await serve((_req, res) => res.writeHead(404).end());
    const wss = createWebSocketServer(server.server, {
      verifyClient: { isPlatform: false, authenticateWebSocket },
      chat: {} as never,
      shell: {} as never,
      getPluginPort: (() => undefined) as never,
      remote: gateway,
      authEpoch: { subscribe: onAuthEpochChange, closesRegularSockets: () => !process.env.JWT_SECRET },
    });

    const mainJwt = user.jwt;
    const issueFor = (peerId: string): string => issueTabToken({ userId: user.id, username: user.username, peerId });
    const tabToken = issueFor(peer.id);

    const connect = (url: string, protocols?: string[]): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url, protocols, { handshakeTimeout: 10_000 });
        socket.once('open', () => resolve(socket));
        socket.once('unexpected-response', (_req, res) => {
          res.resume();
          reject(new Error(`refused:${res.statusCode}`));
        });
        socket.once('error', reject);
      });

    const harness: GatewayHarness = {
      port: server.port,
      wss,
      link,
      peerId: peer.id,
      otherPeerId: other.id,
      tabToken,
      mainJwt,
      clock,
      logoutAll: () => logoutEverywhere(user),
      registry,
      issueFor,
      openTab: ({ channel = 'ws', peerId = peer.id, token = tabToken, protocols, query = '' } = {}) =>
        connect(`ws://127.0.0.1:${server.port}/r/${peerId}/${channel}${query}`, protocols ?? ['cloudcli-tab', token]),
      openRegular: (token = mainJwt) => connect(`ws://127.0.0.1:${server.port}/desktop-notifications?token=${token}`),
      async refusal(path, protocols) {
        try {
          const socket = await connect(`ws://127.0.0.1:${server.port}${path}`, protocols);
          socket.close();
          return 101;
        } catch (error) {
          const match = /refused:(\d+)/.exec(String((error as Error).message));
          if (match) return Number(match[1]);
          throw error;
        }
      },
      async nextStream(index = 0) {
        await waitFor(() => link.streams.length > index, `stream #${index}`);
        return link.streams[index];
      },
    };
    try {
      await run(harness);
    } finally {
      for (const client of wss.clients) client.terminate();
      wss.close(); // also ends the Remote sockets (they live on the gateway's own server)
      await server.close();
    }
  });

/** Resolves with the close event of a socket (code and reason). */
export const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve({ code: 0, reason: '' });
      return;
    }
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
