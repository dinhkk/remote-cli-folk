/**
 * Test rig for the Controller's `/r/<peerId>/**` HTTP proxy: the real router and peer registry over a
 * scripted link (`fake-link`), a real account with real tab tokens on a throwaway database, and an Express
 * server on a loopback port. The test plays the Host by driving the streams the proxy opens.
 */

import express from 'express';

import { createControllerProxyRoutes } from '../../controller/controller-proxy.routes.js';
import { createPeerRegistry } from '../../controller/peer-registry.service.js';
import { createReceiveLedger, resolveReceiveBudgets, type ReceiveBudgets } from '../../controller/receive-budget.js';
import type { RefusedUploadBudgets } from '../../controller/refused-upload-drain.js';
import { createTabTokenService } from '../../controller/tab-token.service.js';

import { createTestAccount, logoutEverywhere } from './auth-test-session.js';
import { createFakeLink, type FakeLink, type FakeStream } from './fake-link.js';
import { serve } from './http-test-client.js';
import { createManualClock, type ManualClock } from './manual-clock.js';
import { createMemoryPairingStore, type MemoryPairingStore } from './memory-pairing-store.js';
import { syntheticPathPolicy } from './synthetic-path-policy.js';
import { withTempDatabase } from './temp-database.js';

export type ProxyHarness = {
  port: number;
  link: FakeLink;
  peerId: string;
  otherPeerId: string;
  tabToken: string;
  otherPeerToken: string;
  mainJwt: string;
  clock: ManualClock;
  store: MemoryPairingStore;
  /** The real "log out everywhere" of the account. */
  logoutEverywhere(): Promise<number>;
  registry: ReturnType<typeof createPeerRegistry>;
  tabs: ReturnType<typeof createTabTokenService>;
  /** Browser connections the proxy currently holds registered with the registry (requests, streams and refused-upload drains). */
  liveConnections(): number;
  /** Waits until the code under test opened its n-th stream, then returns it. */
  nextStream(index?: number): Promise<FakeStream>;
  auth(token?: string): Record<string, string>;
};

export type ProxyHarnessOptions = {
  online?: boolean;
  maxRequestBodyBytes?: number;
  /** Per-stream receive budget only (the default ledger is built around it). */
  receiveBudgetBytes?: number;
  /** Per-stream / per-pairing / global receive budgets (a shared ledger is built from them). */
  receiveBudgets?: Partial<ReceiveBudgets>;
  secret?: string | null;
  /** Time / size / concurrency budgets of the refused-upload drain (defaults: 15 s, 128 MiB, 4 per pairing, 16 total). */
  refusedUpload?: Partial<RefusedUploadBudgets>;
  /** Expiry (epoch ms) of the first pairing. */
  peerExpiresAt?: number;
};

export const waitUntil = async (condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

export const withHarness = async (options: ProxyHarnessOptions, run: (harness: ProxyHarness) => Promise<void>): Promise<void> =>
  withTempDatabase(async () => {
    const account = await createTestAccount('alice');
    const user = { id: account.id, username: account.username };
    const clock = createManualClock(Date.now());
    const store = createMemoryPairingStore(clock.now);
    const peer = store.add({ role: 'controller', name: 'Host', expiresAt: options.peerExpiresAt ?? null });
    const other = store.add({ role: 'controller', name: 'Other Host' });
    const link = createFakeLink('controller');
    if (options.online !== false) {
      link.setStatus({ state: 'online', peerState: 'online' });
      link.setSession(true);
    }
    const registry = createPeerRegistry({
      store,
      getRelaySecret: () => (options.secret === undefined ? 's'.repeat(32) : options.secret),
      isSupported: () => true,
      clock,
      appVersion: 'test',
      createLink: () => link,
    });
    const tabs = createTabTokenService({ hasPeer: registry.hasPeer, isExpired: registry.isExpired });
    // The proxy sees the registry through this wrapper so the tests can tell how many browser connections it holds tracked.
    let live = 0;
    const countingRegistry: Pick<typeof registry, 'attach' | 'trackConnection'> = {
      attach: (peerId) => registry.attach(peerId),
      trackConnection: (peerId, connection) => {
        live += 1;
        const untrack = registry.trackConnection(peerId, connection);
        let released = false;
        return () => {
          untrack();
          if (!released) live -= 1;
          released = true;
        };
      },
    };
    const router = createControllerProxyRoutes({
      tabs,
      registry: countingRegistry,
      maxRequestBodyBytes: options.maxRequestBodyBytes,
      // The tests play the Host with synthetic paths (`/api/projects/slow`, ...).
      evaluateHttp: syntheticPathPolicy,
      receiveBudgetBytes: options.receiveBudgetBytes,
      refusedUpload: options.refusedUpload,
      receiveLedger: options.receiveBudgets ? createReceiveLedger(resolveReceiveBudgets({}, options.receiveBudgets)) : undefined,
    });
    const app = express();
    app.use('/r', router);
    // Anything the proxy does not answer falls through, like the SPA catch-all would.
    app.use((_req, res) => res.status(404).type('text/html').send('<!doctype html>spa'));
    const server = await serve(app);

    // A tab token for a pairing that is already expired cannot be issued; the tests that need one mint it first.
    const issue = (peerId: string): string => tabs.issue({ userId: user.id, username: user.username, peerId }).tabToken;
    const tabToken = issue(peer.id);
    const harness: ProxyHarness = {
      port: server.port,
      link,
      peerId: peer.id,
      otherPeerId: other.id,
      tabToken,
      otherPeerToken: issue(other.id),
      mainJwt: account.jwt,
      clock,
      store,
      logoutEverywhere: () => logoutEverywhere(account),
      registry,
      tabs,
      liveConnections: () => live,
      async nextStream(index = 0) {
        await waitUntil(() => link.streams.length > index, `stream #${index}`);
        return link.streams[index];
      },
      auth: (token = tabToken) => ({ authorization: `Bearer ${token}` }),
    };
    try {
      await run(harness);
    } finally {
      await server.close();
    }
  });
