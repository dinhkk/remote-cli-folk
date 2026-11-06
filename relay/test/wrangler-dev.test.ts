// Runs the shared conformance scenarios against a REAL `wrangler dev` process (workerd) over the `ws`
// library, plus a smoke of an idle period and of the dev server itself.
// Run: npm run test:wrangler   (starts wrangler on a free local port, no Cloudflare account or network needed)
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConformance } from './conformance/scenarios';
import { nodeWsHarness } from './support/node-ws-harness';
import { TEST_RELAY_SECRET } from './support/reference-gate';
import { expectPeer, joinLinkController, registerLinkHost } from './support/session-helpers';
import { makeLinkIdentity, newRoomId } from './support/test-identities';

const relayRoot = resolve(fileURLToPath(import.meta.url), '../..');
const wranglerBin = join(relayRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

let child: ChildProcess | undefined;
let stateDir = '';
let output = '';
let baseUrl = '';

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`wrangler dev exited early (${child.exitCode}):\n${output.slice(-2000)}`);
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become healthy in ${timeoutMs} ms:\n${output.slice(-2000)}`);
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  stateDir = mkdtempSync(join(tmpdir(), 'relay-wrangler-'));
  child = spawn(
    process.execPath,
    [wranglerBin, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir, '--var', `RELAY_SECRET:${TEST_RELAY_SECRET}`, '--log-level', 'warn'],
    { cwd: relayRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
  );
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  await waitForHealth(baseUrl, 100_000);
}, 120_000);

afterAll(() => {
  if (child?.pid) {
    try {
      // wrangler spawns workerd as a grandchild; kill the whole tree
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe('wrangler dev (real workerd)', () => {
  it('starts locally and answers /healthz', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it('does not leak the relay secret or any token-like value into its console output', () => {
    expect(output).not.toContain(TEST_RELAY_SECRET);
  });
});

// Scenarios that need to move the relay's clock are skipped here; they run in the in-pool suite.
// The port is only known after beforeAll, so the harness binds to it lazily.
const live = () => nodeWsHarness('wrangler dev + ws', baseUrl, TEST_RELAY_SECRET);
runConformance({
  name: 'wrangler dev + ws',
  get origin() {
    return live().origin;
  },
  connect: (p) => live().connect(p),
  http: (path) => live().http(path),
  gate: (kind, room) => live().gate(kind, room),
});

describe('wrangler dev: idle period', () => {
  it('keeps both sessions alive and relaying after a quiet spell, with state intact', async () => {
    const h = nodeWsHarness('wrangler dev + ws', baseUrl, TEST_RELAY_SECRET);
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);

    await new Promise((r) => setTimeout(r, 15_000)); // longer than the idle time after which a DO may hibernate
    controller.sendBinary(new Uint8Array([1, 2, 3]));
    expect([...(await host.nextBinary(10_000))]).toEqual([1, 2, 3]);
    host.sendBinary(new Uint8Array([4]));
    expect([...(await controller.nextBinary(10_000))]).toEqual([4]);
    controller.close();
    await expectPeer(host, false);
    host.close();
  }, 60_000);
});
