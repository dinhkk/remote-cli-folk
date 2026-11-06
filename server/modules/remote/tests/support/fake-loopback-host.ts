/**
 * A fake cloudcli Host for bridge tests: a real Express app and a real `ws` server on 127.0.0.1 that
 * record exactly what reaches them (request line, headers, body bytes, upgrade URL, WebSocket
 * messages) and offer routes for the behaviours the bridge must survive: JSON, echo, SSE, big
 * streamed downloads, auth failures, hostile response headers, silence, stalls and broken bodies.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

export type RecordedRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean };
export type RecordedUpgrade = { url: string; headers: http.IncomingHttpHeaders };

export type FakeHost = {
  port: number;
  requests: RecordedRequest[];
  upgrades: RecordedUpgrade[];
  wsConnections: WebSocket[];
  wsReceived: Array<{ data: Buffer; binary: boolean; url: string }>;
  /** TCP connections accepted (a smuggled second request would show up as an extra request, not here). */
  readonly connections: number;
  /** Requests the client abandoned before the response finished. */
  aborted: number;
  /** Times the big-download route had to wait for the socket to drain (the bridge was applying backpressure). */
  drainWaits: number;
  /** While set, WebSocket upgrades are refused with this HTTP status. */
  rejectUpgradeWith: number | null;
  close(): Promise<void>;
};

/** Deterministic bytes so tests can compare a download without keeping it all. */
export const patternBytes = (length: number, seed = 1): Buffer => {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
};

export const sha256 = (data: Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex');

export const startFakeHost = async (): Promise<FakeHost> => {
  const requests: RecordedRequest[] = [];
  const upgrades: RecordedUpgrade[] = [];
  const wsConnections: WebSocket[] = [];
  const wsReceived: FakeHost['wsReceived'] = [];
  let connections = 0;
  const state = { aborted: 0, drainWaits: 0, rejectUpgradeWith: null as number | null };

  const app = express();
  // Answers before the body is read (like a Host that rejects an upload early); not recorded.
  app.post('/api/projects/early-reply', (_req, res) => {
    res.status(413).json({ error: 'too big' });
  });
  // Raw body capture (no body parser: the bridge's bytes are what we want to see).
  app.use((req, res, next) => {
    const record: RecordedRequest = { method: req.method, url: req.originalUrl, headers: req.headers, body: Buffer.alloc(0), complete: false };
    requests.push(record);
    const chunks: Buffer[] = [];
    res.on('close', () => {
      if (!res.writableFinished) state.aborted += 1;
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      record.body = Buffer.concat(chunks);
      record.complete = true;
      next();
    });
    req.on('error', () => undefined);
  });

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: [{ name: 'demo' }] });
  });

  app.all('/api/projects/echo', (req, res) => {
    const record = requests[requests.length - 1];
    res.json({ method: req.method, url: req.originalUrl, length: record.body.length, sha256: sha256(record.body), headers: req.headers });
  });

  app.get('/api/projects/sse', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(`data: event-${sent}\n\n`);
      if (sent === 3) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
    res.on('close', () => clearInterval(timer));
  });

  app.get('/api/projects/big', (req, res) => {
    const total = Number(req.query.bytes ?? 0);
    const data = patternBytes(total, 7);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) });
    let offset = 0;
    const pump = (): void => {
      while (offset < total) {
        const end = Math.min(offset + 65_536, total);
        const ok = res.write(data.subarray(offset, end));
        offset = end;
        if (!ok) {
          state.drainWaits += 1;
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });

  app.get('/api/projects/status/:code', (req, res) => {
    res.status(Number(req.params.code));
    res.setHeader('X-Refreshed-Token', 'eyJhbGciOi.NEW.TOKEN');
    res.setHeader('X-Auth-Error', 'session-expired');
    res.setHeader('Set-Cookie', ['sid=abc; HttpOnly', 'other=1']);
    res.setHeader('Location', 'https://evil.example/');
    res.setHeader('Content-Security-Policy', "script-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('X-Request-Id', 'host-req-1');
    res.json({ error: 'Invalid token', code: 'AUTH_TOKEN_INVALID' });
  });

  // Redirects: `?to=<url>&status=<3xx>`. The bridge must relay a bare status and never follow `Location`.
  app.get('/api/projects/redirect', (req, res) => {
    res.redirect(Number(req.query.status ?? 302), String(req.query.to ?? '/'));
  });

  // Content type under test: `?type=<raw value>`; no `type` at all means no Content-Type header.
  app.get('/api/projects/ctype', (req, res) => {
    const type = req.query.type;
    res.writeHead(200, typeof type === 'string' ? { 'content-type': type } : {});
    res.end('{"ok":true}');
  });

  // A legitimate Host refusal (not an authentication failure), like file-tree's PATH_OUTSIDE_PROJECT.
  app.get('/api/projects/forbidden', (_req, res) => {
    res.status(403).json({ error: 'Path is outside the project', code: 'PATH_OUTSIDE_PROJECT' });
  });

  app.get('/api/assets/files/:name', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.name}"`);
    res.send('<script>document.title="pwned"</script>');
  });

  app.get('/api/projects/silent', () => undefined);

  app.get('/api/projects/stall', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
  });

  app.get('/api/projects/break', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
    res.write('0123456789');
    setTimeout(() => req.socket.destroy(), 20);
  });

  app.get('/api/projects/empty', (_req, res) => {
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  const server = http.createServer(app);
  server.on('connection', () => {
    connections += 1;
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: (info, callback) => {
      upgrades.push({ url: info.req.url ?? '', headers: info.req.headers });
      if (state.rejectUpgradeWith !== null) callback(false, state.rejectUpgradeWith, 'refused');
      else callback(true);
    },
  });
  wss.on('connection', (socket, request) => {
    wsConnections.push(socket);
    const url = request.url ?? '';
    socket.on('message', (data, binary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      wsReceived.push({ data: buffer, binary, url });
      // Test directives travel inside valid protocol messages: {"type":"chat.subscribe","fake":"burst:3:1000"}.
      let directive = '';
      try {
        directive = String((JSON.parse(buffer.toString('utf8')) as { fake?: string }).fake ?? '');
      } catch {
        // not JSON: plain echo
      }
      const closeMatch = /^close:(\d+)$/.exec(directive);
      if (!binary && closeMatch) {
        socket.close(Number(closeMatch[1]), 'bye');
        return;
      }
      const burst = /^burst:(\d+):(\d+)$/.exec(directive);
      if (!binary && burst) {
        for (let i = 0; i < Number(burst[1]); i += 1) socket.send(patternBytes(Number(burst[2]), i + 1), { binary: true });
        return;
      }
      socket.send(buffer, { binary });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    requests,
    upgrades,
    wsConnections,
    wsReceived,
    get connections() {
      return connections;
    },
    get aborted() {
      return state.aborted;
    },
    set aborted(value: number) {
      state.aborted = value;
    },
    get drainWaits() {
      return state.drainWaits;
    },
    set drainWaits(value: number) {
      state.drainWaits = value;
    },
    get rejectUpgradeWith() {
      return state.rejectUpgradeWith;
    },
    set rejectUpgradeWith(value: number | null) {
      state.rejectUpgradeWith = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of wsConnections) socket.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/**
 * A TCP server that accepts connections and never answers and never reads (past the socket's own small
 * read buffer): models a Host that hangs mid-handshake or stops consuming a request body.
 */
export const startSilentServer = async (): Promise<{ port: number; readonly openConnections: number; drain(): void; close(): Promise<void> }> => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    get openConnections() {
      return sockets.size;
    },
    /**
     * Starts reading (and discarding) on every open connection. A server that is not reading cannot see
     * the client hang up, so a test drains before asking whether the bridge released its loopback socket.
     */
    drain() {
      for (const socket of sockets) socket.resume();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

/** A port nothing listens on (bind, read the number, release). */
export const findClosedPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};
