// A Host peer that is NOT the real server: it pairs with a real Controller server through the real relay using
// the production pairing service and link, then answers (or abuses) every stream however a test scripts it.
// Used for the properties that depend on the Controller not trusting the Host: header leaks, content type,
// cross-peer tokens, response flooding.
import { createRelayLink } from '../../../server/modules/remote/link/relay-link.js';
import { createRelayPairConnector } from '../../../server/modules/remote/link/pair-connector.js';
import { createHostPairingService } from '../../../server/modules/remote/pairing/pairing-host.service.js';
import { createMemoryPairingStore } from '../../../server/modules/remote/tests/support/memory-pairing-store.js';
import { memoryPairLockStore } from '../../../server/modules/remote/tests/support/memory-pair-lock-store.js';
import type { RemoteMuxStream, RemoteRelayLink, RemoteStreamOpen } from '../../../server/shared/types.js';

import type { E2eRelay } from './e2e-relay.js';
import type { E2eServer } from './e2e-server.js';
import { joinControllerAndGetSas } from './e2e-world.js';
import { waitUntil } from './e2e-util.js';

export type HostileRequest = {
  open: Extract<RemoteStreamOpen, { kind: 'http' }>;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  stream: RemoteMuxStream;
};

export type HostileHost = {
  /** The Controller server's peer id for this Host. */
  peerId: string;
  /** The pairing key K both sides derived (for tests that look for it where it must not be). */
  k: Buffer;
  link: RemoteRelayLink;
  /** Every HTTP request the Controller sent, in order. */
  requests: HostileRequest[];
  /** Every WebSocket open the Controller sent. */
  wsOpens: Array<Extract<RemoteStreamOpen, { kind: 'ws' }>['meta']>;
  /** Replaces the HTTP responder (default: 200 `{}`); called once the request body is complete. */
  respond(handler: (request: HostileRequest) => void): void;
  /** Replaces the WebSocket responder (default: accept and stay silent). */
  respondWs(handler: (stream: RemoteMuxStream, open: Extract<RemoteStreamOpen, { kind: 'ws' }>) => void): void;
  stop(): void;
};

/** Pairs with `controller` as a hand-made Host and brings the link up. */
export async function startHostileHost(relay: E2eRelay, controller: E2eServer, hostName = 'hostile-host'): Promise<HostileHost> {
  const store = createMemoryPairingStore();
  const pairing = createHostPairingService({
    connect: createRelayPairConnector({ relayUrl: relay.url, relaySecret: relay.secret }),
    store,
    getRelayUrl: () => relay.url,
    hostName,
    lockStore: memoryPairLockStore(),
  });
  const started = pairing.start();
  const join = await joinControllerAndGetSas(controller, started.code, 'e2e-controller');
  const sas = join.sas;
  const confirmed = pairing.confirmSas(started.pairingId, sas);
  if (!confirmed.ok) throw new Error('the hostile Host could not confirm the SAS');
  const peerId = String(
    (await waitUntil(async () => {
      const status = (await controller.api(`/api/remote/peers/join/${join.joinId}`)).json<{ state: string; peerId?: string }>();
      return status.state === 'done' ? status : null;
    }, 'the join to finish', 20_000)).peerId,
  );

  const record = store.listPairings('host')[0];
  const k = store.openPairingKey(record.id);
  const link = createRelayLink({ role: 'host', k, relayUrl: relay.url, relaySecret: relay.secret, appVersion: 'hostile-host' });

  const requests: HostileRequest[] = [];
  const wsOpens: HostileHost['wsOpens'] = [];
  let httpResponder: (request: HostileRequest) => void = (request) => {
    request.stream.sendResponse({ status: 200, headers: { 'content-type': 'application/json' } });
    request.stream.writeBody(Buffer.from('{}'), true);
  };
  let wsResponder: Parameters<HostileHost['respondWs']>[0] = () => undefined;

  link.onStream((stream, open) => {
    if (open.kind === 'ws') {
      wsOpens.push(open.meta);
      wsResponder(stream, open);
      return;
    }
    const chunks: Buffer[] = [];
    stream.setHandlers({
      onBody: (chunk, fin) => {
        chunks.push(Buffer.from(chunk));
        if (!fin) return;
        const request: HostileRequest = {
          open,
          method: open.meta.method,
          path: open.meta.path,
          headers: open.meta.headers as Record<string, string>,
          body: Buffer.concat(chunks),
          stream,
        };
        requests.push(request);
        httpResponder(request);
      },
    });
  });
  link.start();
  // The Controller opens its link lazily (the UI listing peers does it).
  await controller.api('/api/remote/peers');
  await waitUntil(async () => {
    await controller.api('/api/remote/peers');
    return link.sessionActive;
  }, 'the hostile Host link to come up', 30_000);

  return {
    peerId,
    k,
    link,
    requests,
    wsOpens,
    respond: (handler) => {
      httpResponder = handler;
    },
    respondWs: (handler) => {
      wsResponder = handler;
    },
    stop: () => link.close(),
  };
}
