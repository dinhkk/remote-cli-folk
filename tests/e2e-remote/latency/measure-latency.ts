// Latency of the Remote path, measured with two real servers and a relay:
//
//   npm run measure:latency
//     the in-process FakeRelay on this machine: the cost of encryption, mux framing and the three hops, without a
//     network. A floor, not what a user sees.
//   E2E_RELAY_URL=wss://<relay> E2E_RELAY_SECRET=<secret> npm run measure:latency
//     the same run against a deployed relay (the Host and Controller are still local, so the numbers add the
//     round trips to and from the relay). This needs the relay credentials, which only the user has.
//
// Samples: a keystroke echoed by a real PTY through `/r/<peer>/shell`, and a small GET through `/r/<peer>`
// compared with the same GET made directly on the Host. Prints a markdown table; LATENCY_OUT=<file> also writes it.
import { writeFileSync } from 'node:fs';

import { RemoteSocket } from '../support/e2e-browser-client.js';
import { describeSamples, percentile } from '../support/e2e-process-stats.js';
import { openEchoTerminal, timeEcho } from '../support/e2e-terminal.js';
import { sleep } from '../support/e2e-util.js';
import { startWorld } from '../support/e2e-world.js';

const SAMPLES = Number(process.env.LATENCY_SAMPLES ?? 100);
const TARGET_P95_MS = 250;

const row = (label: string, values: number[]): string =>
  `| ${label} | ${values.length} | ${percentile(values, 50).toFixed(1)} | ${percentile(values, 95).toFixed(1)} | ${Math.max(...values).toFixed(1)} |`;

async function main(): Promise<void> {
  const world = await startWorld();
  try {
    const token = await world.tabToken();
    const external = world.relay.kind === 'external';
    const relayLabel = external ? `deployed relay (${new URL(world.relay.url).host})` : `${world.relay.kind} relay on this machine`;

    // A first request of each kind warms the link and the code paths (JIT, sockets) before anything is timed.
    await world.viaRemote('/api/user/onboarding-status', { token });
    await world.host.api('/api/user/onboarding-status');

    const viaRemote: number[] = [];
    const direct: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      let startedAt = performance.now();
      const remote = await world.viaRemote('/api/user/onboarding-status', { token });
      viaRemote.push(performance.now() - startedAt);
      if (remote.status !== 200) throw new Error(`GET via Remote answered ${remote.status}: ${remote.text}`);
      startedAt = performance.now();
      await world.host.api('/api/user/onboarding-status');
      direct.push(performance.now() - startedAt);
    }

    const socket = await openEchoTerminal(world.host, () => RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token), 'latency-terminal');
    await timeEcho(socket, 'warm0x');
    const echo: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      echo.push(await timeEcho(socket, `lat${index}x`));
      await sleep(50);
    }
    socket.send({ type: 'input', data: '\u0003' });
    socket.close();

    const verdict = percentile(echo, 95) < TARGET_P95_MS ? 'meets' : 'MISSES';
    const table = [
      `Relay: ${relayLabel}. Platform: ${process.platform} (${process.arch}), Node ${process.version}. Samples per row: ${SAMPLES}.`,
      '',
      '| Path | n | p50 ms | p95 ms | max ms |',
      '|---|---|---|---|---|',
      row('terminal keystroke echo via Remote', echo),
      row('small GET via Remote', viaRemote),
      row('same GET directly on the Host', direct),
      '',
      `Target: terminal echo p95 < ${TARGET_P95_MS} ms. This run ${verdict} it (${describeSamples(echo)}).`,
    ].join('\n');
    console.log(table);
    if (process.env.LATENCY_OUT) writeFileSync(process.env.LATENCY_OUT, `${table}\n`);
  } finally {
    await world.stop();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
