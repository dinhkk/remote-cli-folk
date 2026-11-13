/**
 * The Host bridge's only way into the local remotecli server: HTTP requests and WebSocket upgrades to
 * `127.0.0.1:<SERVER_PORT>` (the same port the server listens on). Everything about the request is
 * decided here, not by the Controller (contracts section 3):
 *
 * - the URL is built from the fixed loopback host, the port and the CANONICAL path produced by the
 *   canonicalizer; there is no other input that reaches a URL (no SSRF, no redirect following, no DNS);
 * - `Host` is forced to the loopback authority; `Authorization: Bearer <fresh loopback token>` is issued
 *   for EVERY request and EVERY WebSocket (never cached, never logged); the Host's `API_KEY` is attached
 *   as `x-api-key` when set; a Controller-supplied value for any of these is discarded;
 * - one connection per request (`agent: false`), so a malformed request can never poison a pooled
 *   socket; `strictContentLength` is set as a second line of defence behind the bridge's own byte count.
 */

import http from 'node:http';
import net from 'node:net';

import { WebSocket } from 'ws';

import type { RemoteCanonicalTarget } from '@/shared/types.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 3001;

/** Defence in depth: whatever reaches the URL builder must already look canonical. */
const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,:=@%/]*$/;
const SAFE_QUERY = /^(?:\?[\x21-\x7e]*)?$/;
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;
/** Names the bridge owns: dropped from whatever headers are passed in. */
const BRIDGE_OWNED_HEADERS = new Set(['host', 'authorization', 'x-api-key']);

/** Options of the loopback client. `issueToken` returns a NEW short-lived token on every call. Consumed by: host-bridge, bridge tests. */
export type LoopbackClientOptions = {
  port: number;
  /**
   * Address of the local server. Defaults to `127.0.0.1`; the remote module passes the specific IP
   * literal the server is bound to when `HOST` is one (a server bound only to such an address does not
   * answer on 127.0.0.1). It must be an IP literal, never a name: no DNS is involved.
   */
  host?: string;
  env: NodeJS.ProcessEnv;
  issueToken: () => string;
};

/** What the bridge wants to send as an HTTP request: canonical target, filtered headers, how to frame the body. Consumed by: bridge-http-stream (through the client). */
export type LoopbackHttpRequest = {
  method: string;
  target: RemoteCanonicalTarget;
  headers: Record<string, string>;
};

/** What the bridge wants for a WebSocket: one of the two fixed endpoints and its limits. Consumed by: bridge-websocket-stream (through the client). */
export type LoopbackWebSocketRequest = {
  path: '/ws' | '/shell';
  handshakeTimeoutMs: number;
  maxPayloadBytes: number;
};

/** The loopback client: the bridge's only way into the local server. Consumed by: bridge-context, bridge-http-stream, bridge-websocket-stream. */
export type LoopbackClient = {
  request(input: LoopbackHttpRequest): http.ClientRequest;
  openWebSocket(input: LoopbackWebSocketRequest): WebSocket;
};

/**
 * Port of the local server: `SERVER_PORT` exactly as `server/index.ts` reads it (default 3001).
 * Throws on a value that is not a valid port, so a misconfiguration fails loudly at start-up.
 */
// Consumed by: host-bridge (default port).
export function resolveLoopbackPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number.parseInt(env.SERVER_PORT || String(DEFAULT_SERVER_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SERVER_PORT is not a valid port number');
  return port;
}

// Consumed by: host-bridge (one client per bridge).
export function createLoopbackClient(options: LoopbackClientOptions): LoopbackClient {
  const { port, env, issueToken } = options;
  const host = options.host ?? LOOPBACK_HOST;
  if (net.isIP(host) === 0) throw new Error('The loopback host must be an IP address');
  const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;

  /** A new token every call; `x-api-key` only when the Host has an API_KEY. */
  const credentials = (): Record<string, string> => {
    const headers: Record<string, string> = { authorization: `Bearer ${issueToken()}` };
    if (env.API_KEY) headers['x-api-key'] = env.API_KEY;
    return headers;
  };

  return {
    request({ method, target, headers }) {
      if (!SAFE_PATH.test(target.path) || target.path.includes('//') || DOT_SEGMENT.test(target.path) || !SAFE_QUERY.test(target.query)) {
        throw new Error('Refusing a loopback request for a path that is not canonical');
      }
      const merged: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (!BRIDGE_OWNED_HEADERS.has(name.toLowerCase())) merged[name] = value;
      }
      Object.assign(merged, { host: authority }, credentials());
      const request = http.request({
        host,
        port,
        method,
        path: `${target.path}${target.query}`,
        headers: merged,
        agent: false,
        setHost: false,
      });
      // Not an http.request option: a property of the message. Node then refuses a body that disagrees with Content-Length.
      (request as http.ClientRequest & { strictContentLength: boolean }).strictContentLength = true;
      return request;
    },

    openWebSocket({ path, handshakeTimeoutMs, maxPayloadBytes }) {
      return new WebSocket(`ws://${authority}${path}`, {
        headers: credentials(),
        handshakeTimeout: handshakeTimeoutMs,
        maxPayload: maxPayloadBytes,
        perMessageDeflate: false,
        followRedirects: false,
      });
    },
  };
}
