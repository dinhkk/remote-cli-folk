/**
 * Minimal HTTP helpers for the Remote route tests: a raw client over `node:http` (so test requests can
 * set any header, including `Sec-Fetch-Site`, and send a body in pieces) and a function that serves an
 * Express app or a plain request listener on an ephemeral loopback port.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type TestResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
};

export type TestRequest = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** A string/Buffer body is sent as is; an array is sent chunk by chunk. */
  body?: string | Buffer | Buffer[];
  /** Resolve as soon as the response head arrived (for event streams); the body is then read from `stream`. */
  timeoutMs?: number;
};

export type RunningServer = {
  port: number;
  server: http.Server;
  close(): Promise<void>;
};

/** Serves `listener` on 127.0.0.1 with an ephemeral port. */
export const serve = async (listener: http.RequestListener): Promise<RunningServer> => {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

/** Sends one request and reads the whole response. */
export const send = (port: number, request: TestRequest): Promise<TestResponse> =>
  new Promise((resolve, reject) => {
    // Node frames a DELETE body with neither Content-Length nor chunking unless told: declare the length like a browser does.
    const headers = { ...request.headers };
    const hasLength = Object.keys(headers).some((name) => name.toLowerCase() === 'content-length');
    if ((typeof request.body === 'string' || Buffer.isBuffer(request.body)) && !hasLength) {
      headers['content-length'] = String(Buffer.byteLength(request.body));
    }
    const req = http.request({ host: '127.0.0.1', port, method: request.method ?? 'GET', path: request.path, headers, agent: false });
    const timer = setTimeout(() => req.destroy(new Error('test request timed out')), request.timeoutMs ?? 20_000);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          text: () => body.toString('utf8'),
          json: <T>() => JSON.parse(body.toString('utf8')) as T,
        });
      });
    });
    const { body } = request;
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });

/** Opens a request and returns as soon as the response head is in, leaving the body stream to the caller. */
export const open = (
  port: number,
  request: TestRequest,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; res: http.IncomingMessage; req: http.ClientRequest }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: request.method ?? 'GET', path: request.path, headers: request.headers, agent: false });
    req.on('error', reject);
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, res, req }));
    req.end(Array.isArray(request.body) ? Buffer.concat(request.body) : request.body);
  });
