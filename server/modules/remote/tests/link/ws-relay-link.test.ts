import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import type { RemoteRelayLink, RemoteRelaySocketHandlers, RemoteRelaySocketTarget } from '@/shared/types.js';

import { derivePairRoom, normalizePairCode } from '../../crypto/key-derivation.js';
import { createRelayLink } from '../../link/relay-link.js';
import { createRelayPairConnector } from '../../link/pair-connector.js';
import { WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, createWsRelaySocketFactory } from '../../link/relay-socket.js';
import { systemClock } from '../../pairing/pairing-clock.js';
import { FakeRelay } from '../support/fake-relay.js';
import { startFakeRelayWsServer, type FakeRelayWsServer } from '../support/fake-relay-ws-server.js';
import { runDownloadScenario, runEchoScenario, runUploadScenario } from '../support/link-transfer-scenarios.js';
import { createManualClock } from '../support/manual-clock.js';
import { RELAY_SECRET, waitFor } from '../support/relay-link-rig.js';

/** Real WebSocket client and server on loopback; the relay behind the server is the in-process fake. */
const withServer = async (
  body: (context: { relay: FakeRelay; server: FakeRelayWsServer; k: Buffer; links: RemoteRelayLink[] }) => Promise<void>,
  options: { autoPong?: boolean } = {},
) => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  const server = await startFakeRelayWsServer(relay, options);
  const links: RemoteRelayLink[] = [];
  try {
    await body({ relay, server, k: crypto.randomBytes(32), links });
  } finally {
    for (const link of links) link.close();
    await server.close();
  }
};

const makeLink = (
  context: { server: FakeRelayWsServer; k: Buffer; links: RemoteRelayLink[] },
  role: 'host' | 'controller',
  extra: Partial<Parameters<typeof createRelayLink>[0]> = {},
): RemoteRelayLink => {
  const link = createRelayLink({
    role,
    k: context.k,
    relayUrl: context.server.url,
    relaySecret: RELAY_SECRET,
    appVersion: `${role}-ws`,
    clock: systemClock,
    ...extra,
  });
  context.links.push(link);
  return link;
};

test('real WebSockets: two links online, a 25 MiB upload, a 12 MiB download and an ordered echo', { timeout: 180_000 }, async () => {
  await withServer(async (context) => {
    const host = makeLink(context, 'host');
    const controller = makeLink(context, 'controller');
    host.start();
    await waitFor(() => host.status.state === 'online', 'Host online');
    controller.start();
    await waitFor(() => controller.status.state === 'online', 'Controller online');
    assert.equal(controller.peerAppVersion, 'host-ws');
    assert.equal(host.peerAppVersion, 'controller-ws');

    await runUploadScenario(host, controller, 25 * 1024 * 1024);
    await runDownloadScenario(host, controller);
    await runEchoScenario(host, controller);
  });
});

test('real WebSockets: an upgrade the relay refuses (HTTP 401) makes the link rejected, retried after 60 s', async () => {
  await withServer(async (context) => {
    const clock = createManualClock(Date.now());
    const link = makeLink(context, 'host', { relaySecret: 'wrong-secret', clock });
    link.start();
    await waitFor(() => link.status.state === 'rejected', 'the 401 to arrive');
    assert.equal(link.status.reason, 'relay-rejected');
    assert.equal(link.status.retryInMs, 60_000);
    assert.equal(context.server.upgrades(), 1);
    clock.advance(60_000);
    await waitFor(() => context.server.upgrades() === 2, 'the retry');
  });
});

test('real WebSockets: relay close codes reach the link (a second Controller replaces the first with 4409)', async () => {
  await withServer(async (context) => {
    const host = makeLink(context, 'host');
    host.start();
    await waitFor(() => host.status.state === 'online', 'Host online');
    const first = makeLink(context, 'controller');
    first.start();
    await waitFor(() => first.status.state === 'online', 'first Controller online');
    const second = makeLink(context, 'controller');
    second.start();
    await waitFor(() => first.status.state === 'replaced', 'the first Controller to be replaced');
    await waitFor(() => second.status.state === 'online', 'second Controller online');
    assert.equal(first.status.retryInMs, null);
  });
});

test('real WebSockets: a dropped connection is retried with back-off and the session is rebuilt', async () => {
  await withServer(async (context) => {
    const hostClock = createManualClock(Date.now());
    const controllerClock = createManualClock(Date.now());
    const host = makeLink(context, 'host', { clock: hostClock });
    const controller = makeLink(context, 'controller', { clock: controllerClock });
    host.start();
    await waitFor(() => host.status.state === 'online', 'Host online');
    controller.start();
    await waitFor(() => controller.status.state === 'online', 'Controller online');

    context.server.dropClients();
    await waitFor(() => controller.status.state === 'connecting' && host.status.state === 'connecting', 'both links to notice the drop');
    assert.equal(controller.status.reason, 'relay-unreachable');
    assert.equal(controller.status.retryInMs, 1000);
    assert.equal(host.sessionActive, false);

    hostClock.advance(1000);
    await waitFor(() => host.status.state === 'online', 'Host back online');
    controllerClock.advance(1000);
    await waitFor(() => controller.status.state === 'online' && host.sessionActive, 'session rebuilt');
  });
});

test('a relay URL the WebSocket client cannot use is treated as an unreachable relay', async () => {
  await withServer(async (context) => {
    const clock = createManualClock(Date.now());
    const link = makeLink(context, 'host', { relayUrl: 'ftp://nowhere.invalid', clock });
    link.start();
    assert.equal(link.status.state, 'connecting');
    assert.equal(link.status.reason, 'relay-unreachable');
    assert.equal(link.status.retryInMs, 1000);
  });
});

// ---------------------------------------------------------------------------
// The socket adapter itself
// ---------------------------------------------------------------------------

const adapterTarget = (relay: FakeRelay, server: FakeRelayWsServer): RemoteRelaySocketTarget => {
  const room = crypto.randomBytes(16).toString('hex');
  return { relayUrl: server.url, kind: 'link', room, role: 'host', gate: relay.gate('link', room) };
};

const recordingHandlers = () => {
  const record = { opened: 0, texts: [] as string[], binaries: [] as Uint8Array[], closes: [] as Array<{ code: number; http?: number }> };
  const handlers: RemoteRelaySocketHandlers = {
    onOpen: () => {
      record.opened += 1;
    },
    onText: (text) => record.texts.push(text),
    onBinary: (data) => record.binaries.push(data),
    onClose: (code, http) => record.closes.push({ code, http }),
  };
  return { record, handlers };
};

test('socket adapter: a peer that stops answering WebSocket pings is dropped after 25 s + 10 s (1006)', async () => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  const server = await startFakeRelayWsServer(relay, { autoPong: false });
  const clock = createManualClock(0);
  const { record, handlers } = recordingHandlers();
  const socket = createWsRelaySocketFactory({ clock })(adapterTarget(relay, server), handlers);
  try {
    await waitFor(() => record.opened === 1, 'the socket to open');
    clock.advance(WS_PING_INTERVAL_MS - 1);
    assert.equal(record.closes.length, 0);
    clock.advance(1); // ping goes out, nobody answers
    clock.advance(WS_PONG_TIMEOUT_MS - 1);
    assert.equal(record.closes.length, 0);
    clock.advance(1);
    await waitFor(() => record.closes.length === 1, 'the dead socket to be terminated');
    assert.equal(record.closes[0].code, 1006);
    assert.equal(clock.pendingTimers(), 0);
  } finally {
    socket.close();
    await server.close();
  }
});

test('socket adapter: a peer that answers pings keeps the socket open and pinging', async () => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  const server = await startFakeRelayWsServer(relay);
  const manual = createManualClock(0);
  const scheduled: number[] = [];
  const clock = { now: manual.now, setTimer: (fn: () => void, ms: number) => (scheduled.push(ms), manual.setTimer(fn, ms)) };
  const { record, handlers } = recordingHandlers();
  const socket = createWsRelaySocketFactory({ clock })(adapterTarget(relay, server), handlers);
  try {
    await waitFor(() => record.opened === 1, 'the socket to open');
    for (let round = 0; round < 3; round += 1) {
      manual.advance(WS_PING_INTERVAL_MS);
      // ping timer -> pong deadline timer -> (pong received) -> next ping timer
      await waitFor(() => scheduled.length === 1 + 2 * (round + 1), 'the pong to arrive and the next ping to be scheduled');
    }
    assert.deepEqual(scheduled.slice(0, 3), [WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, WS_PING_INTERVAL_MS]);
    assert.equal(record.closes.length, 0);
  } finally {
    socket.close();
    await server.close();
  }
});

test('socket adapter: text and binary go both ways, sends on a closed socket are refused or ignored, close is silent', async () => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  const server = await startFakeRelayWsServer(relay);
  const { record, handlers } = recordingHandlers();
  const target = adapterTarget(relay, server);
  const socket = createWsRelaySocketFactory({ clock: createManualClock(0) })(target, handlers);
  try {
    await waitFor(() => record.opened === 1, 'the socket to open');
    // Authenticate as the Host of a fresh room, then talk binary to nobody (dropped by the relay) and read `ready`.
    const room = deriveLinkKeysFor(target.room);
    socket.sendText(JSON.stringify({ t: 'auth', token: room.token, ctl: room.ctl }));
    await waitFor(() => record.texts.length === 1, 'ready');
    assert.deepEqual(JSON.parse(record.texts[0]), { t: 'ready' });
    await socket.sendBinary(Buffer.from([1, 2, 3])); // the opposite role is absent: dropped, but accepted
    socket.sendText('{"t":"mystery"}'); // the relay answers an unknown text with 4400
    await waitFor(() => record.closes.length === 1, 'the relay to close with 4400');
    assert.deepEqual(record.closes[0], { code: 4400, http: undefined });
    await assert.rejects(async () => socket.sendBinary(Buffer.from([9])), /not open/);
    socket.sendText('ignored on a closed socket');
  } finally {
    socket.close();
    await server.close();
  }

  // An owner-closed socket never calls back.
  const second = recordingHandlers();
  const relay2 = new FakeRelay({ secret: RELAY_SECRET });
  const server2 = await startFakeRelayWsServer(relay2);
  const owned = createWsRelaySocketFactory({ clock: createManualClock(0) })(adapterTarget(relay2, server2), second.handlers);
  try {
    await waitFor(() => second.record.opened === 1, 'the second socket to open');
    owned.close(1000);
    owned.close(1000);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(second.record.closes.length, 0);
    // Closing while still connecting aborts the attempt silently as well.
    const third = recordingHandlers();
    const connecting = createWsRelaySocketFactory({ clock: createManualClock(0) })(adapterTarget(relay2, server2), third.handlers);
    connecting.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(third.record.closes.length, 0);
  } finally {
    await server2.close();
  }
});

test('socket adapter: connection refused is reported as close 1006', async () => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  const server = await startFakeRelayWsServer(relay);
  const target = adapterTarget(relay, server);
  await server.close();
  const { record, handlers } = recordingHandlers();
  createWsRelaySocketFactory({ clock: createManualClock(0) })(target, handlers);
  await waitFor(() => record.closes.length === 1, 'the refused connection to be reported');
  assert.equal(record.closes[0].code, 1006);
  assert.equal(record.opened, 0);
});

test('socket adapter: frames larger than the relay limit are refused and the socket closes', async () => {
  const relay = new FakeRelay({ secret: RELAY_SECRET });
  const raw = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => raw.on('listening', resolve));
  const { port } = raw.address() as { port: number };
  raw.on('connection', (ws) => ws.send(Buffer.alloc(2 * 1024 * 1024 + 1024), { binary: true }));
  const { record, handlers } = recordingHandlers();
  const socket = createWsRelaySocketFactory({ clock: createManualClock(0) })(
    { relayUrl: `ws://127.0.0.1:${port}`, kind: 'link', room: 'a'.repeat(32), role: 'host', gate: relay.gate('link', 'a'.repeat(32)) },
    handlers,
  );
  try {
    await waitFor(() => record.closes.length === 1, 'the oversized frame to be refused');
    assert.ok([1006, 1009].includes(record.closes[0].code), `close code ${record.closes[0].code}`);
    assert.equal(record.binaries.length, 0);
  } finally {
    socket.close();
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  }
});

/** Auth material of a link room is derived from K; for the adapter test a plain token pair is enough. */
const deriveLinkKeysFor = (room: string) => {
  const token = crypto.createHash('sha256').update(`token:${room}`).digest('base64url');
  const ctl = crypto.createHash('sha256').update(`controller:${room}`).digest('hex');
  return { token, ctl };
};

// ---------------------------------------------------------------------------
// The pairing-room connector
// ---------------------------------------------------------------------------

test('pair connector over real WebSockets: both roles meet, exchange frames and finish with destroy (4410)', async () => {
  await withServer(async ({ server }) => {
    const { pairRoomId, pairToken } = derivePairRoom(normalizePairCode('ABCD-EFGH'));
    const connect = createRelayPairConnector({ relayUrl: server.url, relaySecret: RELAY_SECRET });
    const events: string[] = [];
    const hostFrames: number[][] = [];
    const controllerFrames: number[][] = [];
    const host = connect(
      { roomId: pairRoomId, pairToken, role: 'host' },
      {
        onReady: () => events.push('host:ready'),
        onPeer: (up) => events.push(`host:peer:${up}`),
        onFrame: (frame) => hostFrames.push([...frame]),
        onClose: (code) => events.push(`host:close:${code}`),
      },
    );
    await waitFor(() => events.includes('host:ready'), 'Host ready');
    const controller = connect(
      { roomId: pairRoomId, pairToken, role: 'controller' },
      {
        onReady: () => events.push('controller:ready'),
        onPeer: (up) => events.push(`controller:peer:${up}`),
        onFrame: (frame) => controllerFrames.push([...frame]),
        onClose: (code) => events.push(`controller:close:${code}`),
      },
    );
    await waitFor(() => events.includes('host:peer:true') && events.includes('controller:peer:true'), 'both peers up');
    controller.sendFrame(Buffer.from([1, 2, 3]));
    host.sendFrame(Buffer.from([9]));
    await waitFor(() => hostFrames.length === 1 && controllerFrames.length === 1, 'frames to cross');
    assert.deepEqual(hostFrames[0], [1, 2, 3]);
    assert.deepEqual(controllerFrames[0], [9]);

    host.sendDestroy();
    controller.sendDestroy();
    await waitFor(() => events.includes('host:close:4410') && events.includes('controller:close:4410'), 'the room to end');
    host.sendFrame(Buffer.from([1])); // after close: ignored
    host.sendDestroy();
    host.close();
    controller.close();
  });
});

test('pair connector: no room yet (4404), wrong token (4401), refused upgrade (HTTP 401 -> 4401) and silent after close', async () => {
  await withServer(async ({ server }) => {
    const { pairRoomId, pairToken } = derivePairRoom(normalizePairCode('JKMNPQRS'));
    const closes: Record<string, number[]> = { early: [], wrong: [], refused: [], silent: [] };
    const connect = createRelayPairConnector({ relayUrl: server.url, relaySecret: RELAY_SECRET });
    const noop = { onReady: () => undefined, onPeer: () => undefined, onFrame: () => undefined };

    connect({ roomId: pairRoomId, pairToken, role: 'controller' }, { ...noop, onClose: (code) => closes.early.push(code) });
    await waitFor(() => closes.early.length === 1, 'the early Controller to be told there is no room');
    assert.deepEqual(closes.early, [4404]);

    let hostReady = false;
    const host = connect({ roomId: pairRoomId, pairToken, role: 'host' }, { ...noop, onReady: () => (hostReady = true), onClose: () => undefined });
    await waitFor(() => hostReady, 'the Host to be ready');
    connect({ roomId: pairRoomId, pairToken: 'z'.repeat(43), role: 'controller' }, { ...noop, onClose: (code) => closes.wrong.push(code) });
    await waitFor(() => closes.wrong.length === 1, 'the wrong token to be refused');
    assert.deepEqual(closes.wrong, [4401]);

    const badSecret = createRelayPairConnector({ relayUrl: server.url, relaySecret: 'wrong-secret' });
    badSecret({ roomId: pairRoomId, pairToken, role: 'host' }, { ...noop, onClose: (code) => closes.refused.push(code) });
    await waitFor(() => closes.refused.length === 1, 'the refused upgrade to be reported');
    assert.deepEqual(closes.refused, [4401], 'a wrong RELAY_SECRET (HTTP 401 before the upgrade) is reported like the relay\'s own 4401, so it reads as relay-rejected');

    const quiet = connect({ roomId: pairRoomId, pairToken, role: 'controller' }, { ...noop, onClose: (code) => closes.silent.push(code) });
    quiet.close();
    quiet.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(closes.silent, []);
    host.close();
  });
});
