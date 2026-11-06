// A real terminal through Remote: keystrokes in, output and resizes through the mux, a relay drop with the PTY
// still alive, a flood of tens of MB, and typing while a 25 MB upload occupies the link. Windows-adapted: the PTY
// is PowerShell behind ConPTY (the Linux path runs bash).
//
// The heavy replay of 5000 chunks has its own file (e2e-pty-reattach); here the reattach follows the flood, so the
// replayed buffer is the real thing a flooded terminal leaves behind.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { createHostProject } from './support/e2e-host-project.js';
import { uploadInChunks } from './support/e2e-http-upload.js';
import { singleFileUpload } from './support/e2e-multipart.js';
import { describeSamples, percentile, rssMiB } from './support/e2e-process-stats.js';
import { echoLoopCommand, openEchoTerminal, outputText, shellInit, timeEcho, timeLine } from './support/e2e-terminal.js';
import { sleep, waitUntil } from './support/e2e-util.js';
import { startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';

const FLOOD_MB = Number(process.env.E2E_FLOOD_MB ?? 50);
const FLOOD_LINE = 8000;
const FLOOD_LINES = Math.ceil((FLOOD_MB * 1024 * 1024) / (FLOOD_LINE + 1));

/** Prints FLOOD_LINES lines of FLOOD_LINE characters, then the done marker (assembled, see e2e-terminal), then idles. */
const floodCommand = (): string =>
  process.platform === 'win32'
    ? `$p = 'x' * ${FLOOD_LINE}; 1..${FLOOD_LINES} | ForEach-Object { [Console]::Out.Write($p + [char]10) }; Write-Output ('FLOOD-' + 'DONE'); Start-Sleep -Seconds 300`
    : `p=$(head -c ${FLOOD_LINE} /dev/zero | tr '\\0' x); i=0; while [ $i -lt ${FLOOD_LINES} ]; do i=$((i+1)); printf '%s\\n' "$p"; done; echo FLOOD-DONE; sleep 300`;

describe('terminal over the mux', () => {
  let world: RemoteWorld;
  let token = '';
  const openShell = (): Promise<RemoteSocket> => RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token);

  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
  });
  after(async () => {
    await world?.stop();
  });

  it('takes input, answers with output and follows a resize', { timeout: 120_000 }, async (context) => {
    const socket = await openEchoTerminal(world.host, openShell, 'e2e-term-basic', { cols: 100, rows: 30 });
    const first = await timeEcho(socket, 'alpha1');
    context.diagnostic(`first keystroke round trip ${first.toFixed(0)} ms`);

    await timeLine(socket, 'size', 'SIZE:100x30');
    socket.send({ type: 'resize', cols: 140, rows: 40 });
    await sleep(300);
    await timeLine(socket, 'size', 'SIZE:140x40');

    assert.equal(socket.closed, null);
    assert.ok(!outputText(socket).includes('Error:'), 'no error output');
    socket.send({ type: 'input', data: '\u0003' });
    socket.close();
  });

  it('survives a relay drop: the PTY lives on and the re-attached tab takes input again', { timeout: 180_000 }, async () => {
    const first = await openEchoTerminal(world.host, openShell, 'e2e-term-drop');
    await timeEcho(first, 'before1');

    world.relay.cut();
    await first.waitForClose(10_000);
    await waitForPeerState(world.controller, world.peerId, 'online', 60_000);
    const connectionsAfterReconnect = world.relay.connectionCount();

    const second = await waitUntil(() => openShell().catch(() => null), 'the terminal tab to reconnect', 30_000);
    second.send(shellInit(world.host, 'e2e-term-drop', echoLoopCommand()));
    await second.waitFor((message) => message.type === 'output' && String(message.data).includes('Reconnected to existing session'), 'the reattach notice', 30_000);
    await timeEcho(second, 'after22');

    await sleep(3000);
    assert.equal(world.relay.connectionCount(), connectionsAfterReconnect, 'no reconnect loop');
    assert.equal(second.closed, null);
    second.send({ type: 'input', data: '\u0003' });
    second.close();
  });

  it(`a ${FLOOD_MB} MB flood neither hangs the link nor grows either server without bound; a re-attach afterwards replays cleanly`, { timeout: 420_000 }, async (context) => {
    const hostPid = world.host.pid();
    const controllerPid = world.controller.pid();
    assert.ok(hostPid && controllerPid, 'both servers are running');
    const rssBefore = { host: rssMiB(hostPid), controller: rssMiB(controllerPid) };

    // A small request keeps being answered while the flood runs.
    const probes: number[] = [];
    let probing = true;
    const prober = (async () => {
      while (probing) {
        const startedAt = performance.now();
        const response = await world.viaRemote('/api/user/onboarding-status', { token });
        assert.equal(response.status, 200, response.text);
        probes.push(performance.now() - startedAt);
        await sleep(400);
      }
    })();

    const flood = await openShell();
    const floodInit = shellInit(world.host, 'e2e-term-flood', floodCommand(), { cols: 200, rows: 40 });
    const startedAt = Date.now();
    flood.send(floodInit);
    try {
      await flood.waitFor((message) => message.type === 'output' && String(message.data).includes('FLOOD-DONE'), 'the flood to finish', 380_000);
    } finally {
      probing = false;
      await prober;
    }
    const seconds = (Date.now() - startedAt) / 1000;
    const received = flood.inbox.filter((message) => message.type === 'output').reduce((sum, message) => sum + String(message.data).length, 0);
    const rssAfter = { host: rssMiB(hostPid), controller: rssMiB(controllerPid) };
    context.diagnostic(
      `flood ${(received / 1048576).toFixed(1)} MiB received in ${seconds.toFixed(1)} s; rss host ${rssBefore.host.toFixed(0)}->${rssAfter.host.toFixed(0)} MiB, controller ${rssBefore.controller.toFixed(0)}->${rssAfter.controller.toFixed(0)} MiB; probes ${describeSamples(probes)}`,
    );

    assert.equal(flood.closed, null, 'the flood did not close the stream');
    assert.ok(rssAfter.host - rssBefore.host < 400, `Host grew by ${(rssAfter.host - rssBefore.host).toFixed(0)} MiB`);
    assert.ok(rssAfter.controller - rssBefore.controller < 400, `Controller grew by ${(rssAfter.controller - rssBefore.controller).toFixed(0)} MiB`);
    assert.ok(percentile(probes, 95) < 10_000, `a small GET took ${percentile(probes, 95).toFixed(0)} ms (p95) during the flood`);

    // The relay drops after the flood; the re-attach replays what the PTY kept.
    world.relay.cut();
    await flood.waitForClose(10_000);
    await waitForPeerState(world.controller, world.peerId, 'online', 60_000);
    const connections = world.relay.connectionCount();
    const again = await waitUntil(() => openShell().catch(() => null), 'the terminal tab to reconnect', 30_000);
    again.send(floodInit);
    await again.waitFor((message) => message.type === 'output' && String(message.data).includes('Reconnected to existing session'), 'the reattach notice', 30_000);
    await again.waitFor((message) => message.type === 'output' && String(message.data).includes('FLOOD-DONE'), 'the replay to reach its end', 180_000);
    await sleep(3000);
    assert.equal(again.closed, null, 'the replay did not close the stream');
    assert.equal(world.relay.connectionCount(), connections, 'the replay did not make the link reconnect');
    assert.ok(!world.host.output().includes('REMOTE_QUOTA'));
    assert.ok(!world.controller.output().includes('quota-exceeded'));
    again.send({ type: 'input', data: '\u0003' });
    again.close();
  });

  it('keeps typing responsive while a 25 MB upload runs through the same link', { timeout: 240_000 }, async (context) => {
    const project = await createHostProject(world.host, 'upload-typing');
    const socket = await openEchoTerminal(world.host, openShell, 'e2e-term-typing');
    const idle: number[] = [];
    for (let index = 0; index < 15; index += 1) idle.push(await timeEcho(socket, `idle${index}x`));

    // Uploads run back to back until enough keystrokes were timed: a 25 MB upload alone ends in well under a second on this machine.
    const uploadUrl = `/r/${world.peerId}/api/file-tree/projects/${project.id}/files/upload`;
    let uploadsDone = 0;
    let uploadFailure = '';
    let stopUploading = false;
    const upload = singleFileUpload('files', 'typing-upload.bin', 25_000_000); // the same file each time: the Host overwrites it
    const uploading = (async () => {
      for (let round = 0; round < 200 && !stopUploading; round += 1) {
        const outcome = await uploadInChunks(world.controller.baseUrl, uploadUrl, {
          headers: { authorization: `Bearer ${token}`, 'content-type': upload.contentType },
          body: upload.body,
        });
        if (outcome.kind !== 'response' || outcome.status !== 200) {
          uploadFailure = outcome.kind === 'response' ? `${outcome.status} ${outcome.text}` : 'aborted';
          return;
        }
        uploadsDone += 1;
      }
    })();
    const busy: number[] = [];
    while (busy.length < 40 && !uploadFailure) {
      busy.push(await timeEcho(socket, `busy${busy.length}x`));
      await sleep(30);
    }
    stopUploading = true;
    await uploading;
    assert.equal(uploadFailure, '');
    assert.ok(uploadsDone >= 1, 'at least one 25 MB upload finished while typing');
    context.diagnostic(`typing round trips: idle ${describeSamples(idle)}; during ${uploadsDone}+ 25 MB uploads ${describeSamples(busy)}`);
    assert.ok(busy.length >= 20, `only ${busy.length} keystrokes were timed`);
    assert.ok(percentile(busy, 95) < 250, `typing p95 ${percentile(busy, 95).toFixed(0)} ms during the uploads`);
    socket.send({ type: 'input', data: '\u0003' });
    socket.close();
  });
});
