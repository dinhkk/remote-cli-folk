// One REAL cloudcli server as a child process (server/index.ts, or the built dist-server when
// E2E_SERVER_ENTRY=dist). Everything that could touch the developer's machine is redirected: database,
// master key file, HOME/USERPROFILE/APPDATA (so ~/.cloudcli and ~/.claude are never opened), random port.
// The Claude SDK is replaced by tests/e2e-remote/support/fake-claude-query.mjs through the NODE_ENV=test seam.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FORK_ROOT, freePort, waitUntil } from './e2e-util.js';

export const E2E_PASSWORD = 'correct horse battery staple';

export type ApiResponse = {
  status: number;
  headers: Headers;
  text: string;
  json<T = Record<string, unknown>>(): T;
};

export type ApiOptions = {
  method?: string;
  /** JSON body (sent as application/json) unless `rawBody` is given. */
  body?: unknown;
  rawBody?: string | Buffer;
  /** Bearer token; defaults to the server's own admin JWT, `null` sends none. */
  token?: string | null;
  headers?: Record<string, string>;
};

export type E2eServer = {
  name: string;
  port: number;
  baseUrl: string;
  /** Redirected HOME / USERPROFILE of the child. */
  home: string;
  /** SQLite file of this server and the directory that holds all of its data. */
  dbPath: string;
  dataDir: string;
  /** Every line the child printed (stdout + stderr), across restarts. */
  output(): string;
  username: string;
  password: string;
  /** Current admin JWT (replaced by `relogin`). */
  jwt: string;
  /** Request against this server as the admin (or as `options.token`). */
  api(pathAndQuery: string, options?: ApiOptions): Promise<ApiResponse>;
  /** Fresh login (needed after logout-all rotated the secret). */
  relogin(): Promise<string>;
  /** JSON lines the scripted provider wrote (what the Host's provider actually received). */
  providerLog(): Array<Record<string, any>>;
  /** OS process id of the running child (resident-set sampling in the load tests). */
  pid(): number | undefined;
  /** Stops the process and starts it again on the same port and data; `null` removes a variable. */
  restart(envChanges?: Record<string, string | null>): Promise<void>;
  stop(): Promise<void>;
};

export type StartServerOptions = {
  name: string;
  /** An already installed local baseline checkout, used only for upgrade compatibility tests. */
  sourceRoot?: string;
  legacyAuth?: boolean;
  env?: Record<string, string>;
  /** false: do not create the admin account (platform mode has no registration). */
  register?: boolean;
};

const FAKE_QUERY_MODULE = path.join(FORK_ROOT, 'tests', 'e2e-remote', 'support', 'fake-claude-query.mjs');

const toResponse = async (response: Response): Promise<ApiResponse> => {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: <T>() => JSON.parse(text) as T,
  };
};

/** Starts a server and registers its admin account. Resolves when `/health` answers and the account exists. */
export async function startE2eServer({ name, env = {}, register = true, sourceRoot = FORK_ROOT, legacyAuth = false }: StartServerOptions): Promise<E2eServer> {
  const root = await mkdtemp(path.join(os.tmpdir(), `e2e-remote-${name}-`));
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.remotecli'), { recursive: true });
  await mkdir(path.join(home, '.cloudcli'), { recursive: true });
  await mkdir(path.join(root, 'appdata'), { recursive: true });
  const logFile = path.join(root, 'provider-log.jsonl');
  const port = await freePort();
  const userEnv: Record<string, string> = { ...env };

  const buildEnv = (): NodeJS.ProcessEnv => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Ambient configuration of the developer's machine must not leak into the server under test.
    for (const key of Object.keys(childEnv)) {
      if (/^(API_KEY|IS_PLATFORM|VITE_IS_PLATFORM|JWT_SECRET|REMOTECLI_|CLOUDCLI_|ANTHROPIC_|CLAUDE_|NODE_OPTIONS)/i.test(key)) delete childEnv[key];
    }
    return Object.assign(childEnv, {
      NODE_ENV: 'test',
      SERVER_PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: path.join(root, 'auth.db'),
      REMOTECLI_REMOTE_MASTER_KEY_FILE: path.join(root, 'remote-master.key'),
      REMOTECLI_TEST_CLAUDE_QUERY_MODULE: FAKE_QUERY_MODULE,
      CLOUDCLI_REMOTE_MASTER_KEY_FILE: path.join(root, 'remote-master.key'),
      CLOUDCLI_TEST_CLAUDE_QUERY_MODULE: FAKE_QUERY_MODULE,
      E2E_FAKE_PROVIDER_LOG: logFile,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(root, 'appdata'),
      LOCALAPPDATA: path.join(root, 'appdata'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      TSX_TSCONFIG_PATH: 'server/tsconfig.json',
      ...userEnv,
    });
  };

  const chunks: string[] = [];
  let child: ChildProcess | undefined;
  let exited = true;

  const launch = (): void => {
    const useBuild = process.env.E2E_SERVER_ENTRY === 'dist';
    const args = useBuild ? ['dist-server/server/index.js'] : ['--import', 'tsx', 'server/index.ts'];
    const spawned = spawn(process.execPath, args, { cwd: sourceRoot, env: buildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    spawned.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    exited = false;
    spawned.once('exit', () => {
      if (child === spawned) exited = true;
    });
    child = spawned;
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  const output = (): string => chunks.join('');

  const waitHealthy = (): Promise<boolean> =>
    waitUntil(
      async () => {
        if (exited) throw new Error(`[${name}] the server exited early:\n${output().slice(-3000)}`);
        try {
          return (await fetch(`${baseUrl}/health`)).status === 200;
        } catch {
          return false;
        }
      },
      `[${name}] /health`,
      120_000,
    );

  const kill = async (): Promise<void> => {
    const current = child;
    if (!current || exited) return;
    await new Promise<void>((resolve) => {
      current.once('exit', () => resolve());
      current.kill();
      setTimeout(() => {
        if (!exited) current.kill('SIGKILL');
      }, 5000).unref();
    });
  };

  const stop = async (): Promise<void> => {
    await kill();
    if (process.env.E2E_KEEP !== '1') await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  };

  const server: E2eServer = {
    name,
    port,
    baseUrl,
    home,
    dbPath: path.join(root, 'auth.db'),
    dataDir: root,
    output,
    username: 'e2e-admin',
    password: E2E_PASSWORD,
    jwt: '',
    async api(pathAndQuery, options = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      headers['x-remotecli-request'] ??= '1';
      headers.origin ??= baseUrl;
      if (!['GET', 'HEAD'].includes(options.method ?? 'GET')) headers['content-type'] ??= 'application/json';
      // A server started with API_KEY demands it on every /api call (the stock behaviour).
      if (userEnv.API_KEY && pathAndQuery.startsWith('/api/')) headers['x-api-key'] ??= userEnv.API_KEY;
      const token = options.token === undefined ? server.jwt : options.token;
      if (token) {
        if (legacyAuth || pathAndQuery.startsWith('/r/')) headers.authorization = `Bearer ${token}`;
        else headers.cookie = `remotecli_session=${token}`;
      }
      let body: string | Buffer | undefined = options.rawBody;
      if (options.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        body = JSON.stringify(options.body);
      }
      return toResponse(await fetch(`${baseUrl}${pathAndQuery}`, { method: options.method ?? 'GET', headers, body }));
    },
    async relogin() {
      const response = await server.api('/api/auth/login', { method: 'POST', token: null, body: { username: server.username, password: server.password } });
      if (response.status !== 200) throw new Error(`[${name}] login failed: ${response.status} ${response.text}`);
      server.jwt = legacyAuth ? response.json<{ token: string }>().token
        : response.headers.get('set-cookie')!.split(';', 1)[0].split('=')[1];
      return server.jwt;
    },
    providerLog() {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>);
    },
    pid: () => (exited ? undefined : child?.pid),
    async restart(envChanges = {}) {
      await kill();
      for (const [key, value] of Object.entries(envChanges)) {
        if (value === null) delete userEnv[key];
        else userEnv[key] = value;
      }
      launch();
      await waitHealthy();
    },
    stop,
  };

  try {
    launch();
    await waitHealthy();
    if (!register) return server;
    const registered = await server.api('/api/auth/register', { method: 'POST', token: null, body: { username: server.username, password: server.password } });
    if (registered.status !== 200) throw new Error(`[${name}] register failed: ${registered.status} ${registered.text}`);
    server.jwt = legacyAuth ? registered.json<{ token: string }>().token
      : registered.headers.get('set-cookie')!.split(';', 1)[0].split('=')[1];
  } catch (error) {
    await stop();
    throw error;
  }
  return server;
}
