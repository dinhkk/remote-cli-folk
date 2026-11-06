// What survives a restart, what must never be on disk in the clear (AC-28), and what a lost master key does
// (fail closed, never a silent new key): real server processes restarted on the same data.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { configureRelay, startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';
import { startE2eRelay, type E2eRelay } from './support/e2e-relay.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';
import { sleep, waitUntil } from './support/e2e-util.js';

/** Every file of a server's data directory except the master key file itself. */
const dataFiles = (server: E2eServer): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'remote-master.key') found.push(full);
    }
  };
  walk(server.dataDir);
  return found;
};

describe('secrets at rest (AC-28)', () => {
  let relay: E2eRelay;
  let controller: E2eServer;
  let host: HostileHost;
  before(async () => {
    relay = await startE2eRelay();
    controller = await startE2eServer({ name: 'controller' });
    await configureRelay(relay, controller);
    host = await startHostileHost(relay, controller);
  });
  after(async () => {
    host?.stop();
    await controller?.stop();
    await relay?.stop();
  });

  it('the Controller database holds neither K nor the relay secret in any readable form', async () => {
    await controller.api('/api/remote/peers'); // make sure the pairing row and the settings are flushed
    await sleep(500);
    const needles = new Map<string, Buffer>([
      ['relay secret', Buffer.from(relay.secret, 'utf8')],
      ['K (raw)', host.k],
      ['K (hex)', Buffer.from(host.k.toString('hex'), 'utf8')],
      ['K (base64)', Buffer.from(host.k.toString('base64'), 'utf8')],
      ['K (base64url)', Buffer.from(host.k.toString('base64url'), 'utf8')],
    ]);
    const files = dataFiles(controller).filter((file) => /\.db($|-wal$|-shm$)/.test(file));
    assert.ok(files.length > 0);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const [label, needle] of needles) assert.equal(bytes.includes(needle), false, `${label} found in ${path.basename(file)}`);
    }
    // The settings are really there (sealed): the relay URL and a secret flag come back through the API.
    const config = (await controller.api('/api/remote/relay-config')).json<{ url: string; hasSecret: boolean }>();
    assert.equal(config.hasSecret, true);
    assert.equal(config.url, relay.url);
  });
});

describe('restarts and the master key', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld();
  });
  after(async () => {
    await world.stop();
  });

  it('a restarted Host comes back by itself (Accept and the pairing are persisted) and the same tab token works', async () => {
    const token = await world.tabToken();
    await world.host.restart();
    await waitForPeerState(world.controller, world.peerId, 'online', 90_000);
    const status = (await world.host.api('/api/remote/host/status')).json<{ acceptEnabled: boolean; controllers: unknown[] }>();
    assert.equal(status.acceptEnabled, true);
    assert.equal(status.controllers.length, 1);
    const chat = await waitUntil(() => world.openChat(token).catch(() => null), 'the tab socket after the Host restart', 60_000);
    const sessionId = await world.createSession(token);
    chat.send({ type: 'chat.send', sessionId, content: 'e2e:echo after-restart', options: {} });
    await chat.waitFor((m) => m.kind === 'complete', 'complete');
    chat.close();
  });

  it('a restarted Controller keeps the pairing and reconnects when asked', async () => {
    await world.controller.restart();
    await world.controller.relogin().catch(() => undefined);
    const peers = (await world.controller.api('/api/remote/peers')).json<Array<{ peerId: string }>>();
    assert.equal(peers.length, 1);
    await waitForPeerState(world.controller, world.peerId, 'online', 90_000);
    const token = await world.tabToken();
    assert.equal((await world.viaRemote('/api/projects', { token })).status, 200);
  });

  it('a Host that lost its master key refuses Remote (409 MASTER_KEY_MISMATCH), stays up, and recovers with the right key', async () => {
    const original = world.host.dataDir;
    await world.host.restart({ CLOUDCLI_REMOTE_MASTER_KEY_FILE: path.join(original, 'a-different-master.key') });
    assert.equal((await fetch(`${world.host.baseUrl}/health`)).status, 200, 'the server itself keeps running');
    const blocked = await world.host.api('/api/remote/host/status');
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(blocked.json<{ error: { code: string } }>().error.code, 'MASTER_KEY_MISMATCH');
    // No pairing works without the key: the Controller cannot reach the Host.
    const token = await world.tabToken();
    await waitUntil(async () => (await world.viaRemote('/api/projects', { token })).status === 503, 'the Host to be unreachable', 60_000);

    await world.host.restart({ CLOUDCLI_REMOTE_MASTER_KEY_FILE: path.join(original, 'remote-master.key') });
    assert.equal((await world.host.api('/api/remote/host/status')).status, 200);
    await waitForPeerState(world.controller, world.peerId, 'online', 90_000);
  });

  it('changing the relay secret revokes every pairing on both sides (Host: destroyed at the relay; Controller: forgotten)', async () => {
    const newSecret = 'another-relay-secret-0123456789abcdefghij';
    for (const server of [world.controller, world.host]) {
      const response = await server.api('/api/remote/relay-config', { method: 'PUT', body: { url: world.relay.url, secret: newSecret, password: server.password } });
      assert.equal(response.status, 200, response.text);
    }
    const peers = (await world.controller.api('/api/remote/peers')).json<unknown[]>();
    assert.deepEqual(peers, []);
    const status = (await world.host.api('/api/remote/host/status')).json<{ controllers: unknown[] }>();
    assert.deepEqual(status.controllers, []);
  });
});
