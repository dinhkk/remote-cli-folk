// The relay of the end-to-end runs, behind a TCP tap.
//
//   kind 'fake'     (default, CI): the in-process FakeRelay (passes the phase 04 conformance suite) behind a real
//                   `ws` server; the servers connect with the production `ws` client.
//   kind 'wrangler' (E2E_RELAY=wrangler, final package): a REAL `wrangler dev` (workerd) process.
//
// Either way the servers talk to a TCP proxy owned by this file. The proxy gives the tests what a real
// network gives them for free: it parses the WebSocket frames that cross it (so a test can prove the relay
// only ever saw ciphertext), it can cut every connection (a network drop) and it can refuse new ones for a
// while (a relay outage).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { FakeRelay } from '../../../server/modules/remote/tests/support/fake-relay.js';
import { startFakeRelayWsServer, type FakeRelayWsServer } from '../../../server/modules/remote/tests/support/fake-relay-ws-server.js';

import { FORK_ROOT, freePort, waitUntil } from './e2e-util.js';

/** Must be >= 32 characters (the relay treats a shorter RELAY_SECRET as "not configured"). */
export const E2E_RELAY_SECRET = 'e2e-relay-secret-0123456789abcdefghij';

export type RelayDirection = 'to-relay' | 'from-relay';

export type RelayFrameSummary = { direction: RelayDirection; opcode: number; length: number; head: Buffer };

export type E2eRelay = {
  /** 'external': a relay somebody else runs (`E2E_RELAY_URL` + `E2E_RELAY_SECRET`), reached directly: no tap, no cut/outage. */
  kind: 'fake' | 'wrangler' | 'external';
  /** `ws://127.0.0.1:<port>`: the address the servers are configured with. */
  url: string;
  secret: string;
  /** Summaries of every data frame that crossed the tap (payloads are not kept, see `watch`). */
  frames: RelayFrameSummary[];
  /** Counts payloads that contain any of the given strings (utf8) or raw byte sequences; used for "no plaintext at the relay". */
  watch(needles: Array<string | Buffer>): { hits(): number };
  /** Connections accepted by the tap so far. */
  connectionCount(): number;
  /** Cuts every open relay connection (a network drop). New connections still work. */
  cut(): void;
  /** While true, every connection is refused immediately (relay outage); open ones are cut. */
  setOutage(on: boolean): void;
  stop(): Promise<void>;
};

// --------------------------------------------------------------------------- WebSocket frame tap

/** Incremental parser for one direction of a WebSocket byte stream (after the HTTP upgrade). */
class FrameTap {
  private buffer = Buffer.alloc(0);
  private headersDone = false;

  constructor(
    private readonly direction: RelayDirection,
    private readonly onFrame: (direction: RelayDirection, opcode: number, payload: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.headersDone) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      this.buffer = this.buffer.subarray(end + 4);
      this.headersDone = true;
    }
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) {
        const key = this.buffer.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length);
      this.onFrame(this.direction, opcode, payload);
    }
  }
}

type Tap = { port: number; frames: RelayFrameSummary[]; watch: E2eRelay['watch']; connectionCount(): number; cut(): void; setOutage(on: boolean): void; close(): Promise<void> };

const startTap = async (targetPort: number): Promise<Tap> => {
  const sockets = new Set<net.Socket>();
  const frames: RelayFrameSummary[] = [];
  const watchers: Array<{ needles: Buffer[]; hits: number }> = [];
  let connections = 0;
  let outage = false;

  const onFrame = (direction: RelayDirection, opcode: number, payload: Buffer): void => {
    if (opcode > 2) return; // control frames
    frames.push({ direction, opcode, length: payload.length, head: Buffer.from(payload.subarray(0, 48)) });
    for (const watcher of watchers) {
      if (watcher.needles.some((needle) => payload.includes(needle))) watcher.hits += 1;
    }
  };

  const server = net.createServer((client) => {
    if (outage) {
      client.destroy();
      return;
    }
    connections += 1;
    const upstream = net.connect(targetPort, '127.0.0.1');
    const up = new FrameTap('to-relay', onFrame);
    const down = new FrameTap('from-relay', onFrame);
    sockets.add(client);
    sockets.add(upstream);
    const closeBoth = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('data', (chunk) => {
      up.push(chunk);
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      down.push(chunk);
      client.write(chunk);
    });
    client.on('error', closeBoth).on('close', closeBoth);
    upstream.on('error', closeBoth).on('close', closeBoth);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  const cut = (): void => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  return {
    port,
    frames,
    watch(needles) {
      const watcher = { needles: needles.map((needle) => (typeof needle === 'string' ? Buffer.from(needle, 'utf8') : needle)), hits: 0 };
      watchers.push(watcher);
      return { hits: () => watcher.hits };
    },
    connectionCount: () => connections,
    cut,
    setOutage(on) {
      outage = on;
      if (on) cut();
    },
    close: () =>
      new Promise<void>((resolve) => {
        cut();
        server.close(() => resolve());
      }),
  };
};

// --------------------------------------------------------------------------- relay backends

type Backend = { port: number; stop(): Promise<void> };

const startFakeBackend = async (): Promise<Backend> => {
  const relay = new FakeRelay({ secret: E2E_RELAY_SECRET });
  const server: FakeRelayWsServer = await startFakeRelayWsServer(relay);
  return { port: Number(new URL(server.url).port), stop: () => server.close() };
};

const startWranglerBackend = async (): Promise<Backend> => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-wrangler-'));
  const wranglerBin = path.join(FORK_ROOT, 'relay', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const child: ChildProcess = spawn(
    process.execPath,
    [wranglerBin, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir, '--var', `RELAY_SECRET:${E2E_RELAY_SECRET}`, '--log-level', 'warn'],
    { cwd: path.join(FORK_ROOT, 'relay'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  try {
    await waitUntil(
      async () => {
        if (child.exitCode !== null) throw new Error(`wrangler dev exited early (${child.exitCode}):\n${output.slice(-2000)}`);
        try {
          return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200;
        } catch {
          return false;
        }
      },
      'wrangler dev /healthz',
      120_000,
    );
  } catch (error) {
    killTree(child);
    throw error;
  }
  return {
    port,
    stop: async () => {
      killTree(child);
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
};

/** wrangler spawns workerd as a grandchild: kill the whole tree. */
const killTree = (child: ChildProcess): void => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {
    // already gone
  }
};

/**
 * Starts the relay selected by `E2E_RELAY` (default: fake) behind the tap. With `E2E_RELAY_URL` and
 * `E2E_RELAY_SECRET` set (the latency measurement against a deployed relay) nothing is started and the
 * servers connect to that relay directly.
 */
export async function startE2eRelay(): Promise<E2eRelay> {
  if (process.env.E2E_RELAY_URL) {
    const secret = process.env.E2E_RELAY_SECRET ?? '';
    if (secret.length < 32) throw new Error('E2E_RELAY_SECRET (at least 32 characters) is required with E2E_RELAY_URL');
    const unsupported = (): never => {
      throw new Error('this needs the local tap: not available with E2E_RELAY_URL');
    };
    return {
      kind: 'external',
      url: process.env.E2E_RELAY_URL,
      secret,
      frames: [],
      watch: unsupported,
      connectionCount: () => 0,
      cut: unsupported,
      setOutage: unsupported,
      stop: async () => undefined,
    };
  }
  const kind = process.env.E2E_RELAY === 'wrangler' ? 'wrangler' : 'fake';
  const backend = kind === 'wrangler' ? await startWranglerBackend() : await startFakeBackend();
  const tap = await startTap(backend.port);
  return {
    kind,
    url: `ws://127.0.0.1:${tap.port}`,
    secret: E2E_RELAY_SECRET,
    frames: tap.frames,
    watch: tap.watch,
    connectionCount: tap.connectionCount,
    cut: tap.cut,
    setOutage: tap.setOutage,
    stop: async () => {
      await tap.close();
      await backend.stop();
    },
  };
}
