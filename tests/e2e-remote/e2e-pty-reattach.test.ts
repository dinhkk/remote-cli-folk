// Terminal re-attach through Remote (AC-8, reduced to a fast version; the heavy load profile is phase 12):
// a real PTY on the Host has produced thousands of 4 KiB chunks, the relay drops, the tab re-attaches and the
// Host replays its whole buffer. The replay must neither close the stream, nor trip a quota, nor start a
// reconnect loop; the terminal must still take input afterwards.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { startE2eRelay, type E2eRelay } from './support/e2e-relay.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';
import { configureRelay, startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';
import { sleep, waitUntil } from './support/e2e-util.js';

const CHUNKS = Number(process.env.E2E_PTY_CHUNKS ?? 5200);
const LINE = 4000;

/** A command that prints CHUNKS lines of ~4 KiB, one write each, then stays alive so the PTY can be re-attached. */
const flood = (): string =>
  process.platform === 'win32'
    ? `1..${CHUNKS} | ForEach-Object { [Console]::Out.Write(('L{0:d5}' -f $_) + ('x' * ${LINE}) + [char]10) }; Write-Output E2E-FLOOD-DONE; Start-Sleep -Seconds 300`
    : `i=0; pad=$(head -c ${LINE} /dev/zero | tr '\\0' x); while [ $i -lt ${CHUNKS} ]; do i=$((i+1)); printf 'L%05d%s\\n' $i "$pad"; done; echo E2E-FLOOD-DONE; sleep 300`;

const outputText = (socket: RemoteSocket, from = 0): string =>
  socket.inbox
    .slice(from)
    .filter((m) => m.type === 'output')
    .map((m) => String(m.data))
    .join('');

describe('a Host replaying 5000 x 4 KiB terminal chunks at once (the Windows PTY itself emits smaller chunks)', () => {
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

  it('reaches the browser complete and in order, without closing the stream or the link', { timeout: 180_000 }, async (context) => {
    const token = (await controller.api(`/api/remote/peers/${host.peerId}/tab-token`, { method: 'POST', body: {} })).json<{ tabToken: string }>().tabToken;
    host.respondWs((stream) => {
      // Like the real bridge: write as fast as the queue allows, wait for onResume when it fills up.
      let next = 0;
      let waiting = false;
      const pump = (): void => {
        while (next < 5000 && !stream.closed) {
          const line = Buffer.from(JSON.stringify({ type: 'output', data: `${String(next).padStart(5, '0')}${'y'.repeat(4000)}` }));
          next += 1;
          if (!stream.sendMessage(line, false)) {
            waiting = true;
            return;
          }
        }
        if (next >= 5000 && !stream.closed) stream.sendMessage(Buffer.from(JSON.stringify({ type: 'output', data: 'REPLAY-END' })), false);
      };
      stream.setHandlers({
        onResume: () => {
          if (waiting) {
            waiting = false;
            pump();
          }
        },
        onMessage: () => pump(),
      });
    });
    const socket = await RemoteSocket.open(controller.baseUrl, host.peerId, 'shell', token);
    socket.send({ type: 'init' });
    await socket.waitFor((m) => m.data === 'REPLAY-END', 'the replay to end', 150_000);
    const numbers = socket.inbox.filter((m) => typeof m.data === 'string' && m.data.length > 4000).map((m) => Number(String(m.data).slice(0, 5)));
    context.diagnostic(`received ${numbers.length} chunks of 4 KiB`);
    assert.equal(numbers.length, 5000);
    assert.deepEqual(numbers, Array.from({ length: 5000 }, (_, index) => index), 'in order, none missing');
    assert.equal(socket.closed, null);
    const peers = (await controller.api('/api/remote/peers')).json<Array<{ state: string }>>();
    assert.equal(peers[0].state, 'online');
    socket.close();
  });
});

describe('terminal re-attach after a relay drop', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld();
  });
  after(async () => {
    await world.stop();
  });

  it('replays the PTY buffer without closing the stream, tripping a quota or looping reconnects', { timeout: 300_000 }, async (context) => {
    const token = await world.tabToken();
    const init = {
      type: 'init',
      projectPath: world.host.home,
      sessionId: 'e2e-pty',
      hasSession: false,
      provider: 'plain-shell',
      initialCommand: flood(),
      cols: 200,
      rows: 40,
    };

    const first = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token);
    first.send(init);
    await first.waitFor((m) => m.type === 'output' && String(m.data).includes('E2E-FLOOD-DONE'), 'the flood to finish', 240_000);
    const producedChunks = first.inbox.filter((m) => m.type === 'output').length;
    assert.ok(producedChunks > 500, `the PTY produced ${producedChunks} output messages`);

    // The relay drops while the PTY keeps living on the Host.
    world.relay.cut();
    await first.waitForClose(10_000);
    await waitForPeerState(world.controller, world.peerId, 'online', 60_000);
    const connectionsAtReconnect = world.relay.connectionCount();

    const second = await waitUntil(() => RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token).catch(() => null), 'the terminal tab to reconnect', 30_000);
    second.send(init);
    await second.waitFor((m) => m.type === 'output' && String(m.data).includes('Reconnected to existing session'), 'the reattach notice', 30_000);
    await second.waitFor((m) => m.type === 'output' && String(m.data).includes('E2E-FLOOD-DONE'), 'the replayed buffer to reach its end', 120_000);
    const replayed = second.inbox.filter((m) => m.type === 'output').length;
    const bytes = second.inbox.filter((m) => m.type === 'output').reduce((sum, m) => sum + String(m.data).length, 0);
    context.diagnostic(`PTY produced ${producedChunks} output messages; replay delivered ${replayed} messages, ${(bytes / 1048576).toFixed(1)} MiB`);
    assert.ok(replayed >= Math.min(producedChunks, 5000), `replayed ${replayed} of ${producedChunks} chunks`);
    assert.equal(second.closed, null, 'the replay did not close the stream');
    assert.ok(!outputText(second).includes('Error:'), 'no error output');

    // Stability afterwards: no reconnect loop, no quota teardown of the link, the terminal still answers.
    await sleep(5000);
    assert.equal(world.relay.connectionCount(), connectionsAtReconnect, 'the replay did not make the link reconnect');
    const peers = (await world.controller.api('/api/remote/peers')).json<Array<{ peerId: string; state: string }>>();
    assert.equal(peers.find((peer) => peer.peerId === world.peerId)?.state, 'online');
    // Input still reaches the PTY: Ctrl+C ends the sleeping command and the Host reports the exit.
    const mark = second.inbox.length;
    second.send({ type: 'input', data: '\u0003' });
    await second.waitFor((m) => m.type === 'output' && String(m.data).includes('Process exited'), 'the terminal to react to input', 30_000, mark);
    second.close();

    assert.ok(!world.host.output().includes('REMOTE_QUOTA'));
    assert.ok(!world.controller.output().includes('quota-exceeded'));
  });
});
