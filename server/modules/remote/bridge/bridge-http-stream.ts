/**
 * HTTP half of the Host bridge: one mux HTTP stream -> one loopback request to the local server.
 *
 * Order of events: method + target -> allow-list -> request headers -> loopback request (rebuilt from
 * the canonical path, fresh loopback token, Host API_KEY when set) -> response headers filtered -> body
 * streamed back with backpressure.
 *
 * A Host 401/403 is never relayed as such: it becomes the mux error `REMOTE_UPSTREAM_AUTH` (HTTP 502 at
 * the Controller) and no response head is sent, so `X-Auth-Error`, `X-Refreshed-Token` and friends
 * cannot reach the tab and log Local out. The mapping is deliberately blanket (contracts section 7):
 * a LEGITIMATE Host 403 (file-tree `PATH_OUTSIDE_PROJECT`, `/api/commands/execute` "Access denied") is
 * masked the same way and shows up in the UI as a link/auth problem. Phase 12 may refine it, e.g. by
 * treating a 403 as auth only when the Host sent `x-auth-error`.
 *
 * Direction Controller -> Host has no receive-side flow control in the mux, so the bytes left unsent on
 * the loopback socket are capped (`maxUpstreamBufferedBytes`): past it the stream is cancelled with
 * `REMOTE_QUOTA` instead of letting a slow Host grow the Host process's memory without bound.
 */

import type { ClientRequest, IncomingMessage } from 'node:http';

import type { RemoteErrorCode, RemoteMuxMeta, RemoteMuxStream } from '@/shared/types.js';

import { filterRequestHeaders, filterResponseHeaders } from '../policy/header-filter.js';

import { describeTarget, type BridgeContext, type StreamLifecycle } from './bridge-context.js';
import { classifyHostWrite, createWriteProbe } from './bridge-write-audit.js';

const EMPTY = Buffer.alloc(0);
const BODY_METHODS_WITHOUT_LENGTH = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Serves one HTTP stream the Controller opened. Installs the stream's handlers synchronously (or
 * refuses the stream right away). Consumed by: `createHostBridge`.
 */
export function bridgeHttpStream(
  context: BridgeContext,
  stream: RemoteMuxStream,
  meta: RemoteMuxMeta['HTTP_REQ'],
  lifecycle: StreamLifecycle,
): void {
  const { client, limits, active, report, evaluateHttp } = context;
  const { method, path, headers } = meta;
  const reportBase = { method: method.slice(0, 16), target: describeTarget(path) };

  const decision = evaluateHttp(method, path);
  if (!decision.allowed) {
    const reason = decision.detail ?? decision.reason;
    report({ kind: 'http-request', reason, ...reportBase });
    stream.fail('REMOTE_FORBIDDEN', `Request refused by the Host policy (${reason}).`);
    return;
  }

  const filtered = filterRequestHeaders(headers);
  if (!filtered.ok) {
    report({ kind: 'request-headers', reason: filtered.reason, ...reportBase });
    stream.fail('REMOTE_FORBIDDEN', `Request headers refused by the Host policy (${filtered.reason}).`);
    return;
  }
  const requestHeaders = filtered.headers;
  const declaredLength = requestHeaders['content-length'] === undefined ? undefined : Number(requestHeaders['content-length']);
  if (declaredLength !== undefined && declaredLength > limits.maxRequestBodyBytes) {
    report({ kind: 'request-body', reason: 'declared-length-too-large', ...reportBase });
    stream.fail('REMOTE_TOO_LARGE', 'Request body exceeds the limit.');
    return;
  }
  // Without a declared length the body is framed as chunked (explicitly, so no byte can ever be read as a new request).
  const chunked = declaredLength === undefined && BODY_METHODS_WITHOUT_LENGTH.has(method);
  if (chunked) requestHeaders['transfer-encoding'] = 'chunked';

  let upstreamRequest: ClientRequest;
  try {
    upstreamRequest = client.request({ method, target: decision.canonical, headers: requestHeaders });
  } catch {
    stream.fail('REMOTE_INTERNAL', 'The Host loopback is unavailable.');
    return;
  }

  let done = false;
  let bytesWritten = 0;
  let requestFinished = false;
  let responseEnded = false;
  let upstreamResponse: IncomingMessage | undefined;
  let bodyIdleTimer: NodeJS.Timeout | undefined;
  let headersTimer: NodeJS.Timeout | undefined;

  // One audit row per write to the Host (files, git, clone, skills, uploads), with the outcome the Host gave (or
  // why there is none), the route and a few short identifying fields (the file path, ...), never any content.
  const writeKind = classifyHostWrite(method, decision.canonical.path);
  const writeProbe = writeKind ? createWriteProbe(writeKind.area, requestHeaders['content-type']) : undefined;
  let writeAudited = writeKind === null;
  const auditWrite = (result: 'ok' | 'error' | 'refused' | 'closed', status?: number): void => {
    if (writeAudited || !writeKind) return;
    writeAudited = true;
    context.audit({
      event: writeKind.event,
      target: `${method.slice(0, 16)} ${describeTarget(decision.canonical.path)}`,
      result,
      detail: { ...(status === undefined ? {} : { status }), ...writeProbe?.details(path) },
    });
  };

  const fail = (code: RemoteErrorCode, message: string): void => {
    auditWrite('error');
    if (!stream.closed) stream.fail(code, message);
  };
  const cleanup = (): void => {
    done = true;
    clearTimeout(bodyIdleTimer);
    clearTimeout(headersTimer);
    active.delete(stream);
    upstreamResponse?.destroy();
    upstreamRequest.destroy();
  };
  const armBodyIdle = (): void => {
    clearTimeout(bodyIdleTimer);
    bodyIdleTimer = setTimeout(() => {
      if (responseEnded) stream.cancel();
      else fail('REMOTE_INTERNAL', 'Request body timed out.');
    }, limits.requestBodyIdleMs);
    bodyIdleTimer.unref();
  };
  // Starts when the last body byte is handed to the loopback socket, not when the socket has flushed it:
  // a Host that stops reading a big upload never flushes, and must still be cut.
  const armHeadersTimer = (): void => {
    if (upstreamResponse !== undefined) return; // the Host answered early: the head is already here
    clearTimeout(headersTimer);
    headersTimer = setTimeout(() => fail('REMOTE_INTERNAL', 'The Host did not answer in time.'), limits.responseHeadersMs);
    headersTimer.unref();
  };

  const refuseLengthMismatch = (): void => {
    report({ kind: 'request-body', reason: 'length-mismatch', ...reportBase });
    fail('REMOTE_FORBIDDEN', 'Request body does not match its declared length.');
  };

  active.add(stream);
  stream.setHandlers({
    onBody: (chunk, fin) => {
      if (done || responseEnded) return;
      try {
        if (chunk.length > 0) {
          if (declaredLength === undefined && !chunked) {
            report({ kind: 'request-body', reason: 'body-without-length', ...reportBase });
            fail('REMOTE_FORBIDDEN', 'A request body needs a Content-Length for this method.');
            return;
          }
          // The bridge counts the bytes itself: a surplus byte could be read as the start of a second
          // request on the loopback connection, a shortfall would leave the Host waiting for the rest.
          if (declaredLength !== undefined && bytesWritten + chunk.length > declaredLength) return refuseLengthMismatch();
          writeProbe?.push(chunk);
          upstreamRequest.write(chunk);
          bytesWritten += chunk.length;
          if (upstreamRequest.writableLength > limits.maxUpstreamBufferedBytes) {
            fail('REMOTE_QUOTA', 'The Host is not reading the request body fast enough.');
            return;
          }
        }
        if (fin) {
          if (declaredLength !== undefined && bytesWritten !== declaredLength) return refuseLengthMismatch();
          requestFinished = true;
          clearTimeout(bodyIdleTimer);
          upstreamRequest.end();
          armHeadersTimer();
        } else {
          armBodyIdle();
        }
      } catch {
        // Node's own strict check (second line of defence) or a write on a dead socket.
        refuseLengthMismatch();
      }
    },
    onPause: () => upstreamResponse?.pause(),
    onResume: () => upstreamResponse?.resume(),
    onClosed: (end) => {
      auditWrite('closed'); // cancelled or cut before the Host answered: the write may still have happened
      cleanup();
      lifecycle.ended(end);
    },
  });
  armBodyIdle();

  upstreamRequest.on('error', () => {
    // After a complete response a failing request side (the Host replied early and hung up) is not an error.
    if (!done && !responseEnded) fail('REMOTE_INTERNAL', 'The Host loopback request failed.');
  });
  upstreamRequest.on('response', (incoming) => {
    clearTimeout(headersTimer);
    upstreamResponse = incoming;
    if (done) {
      incoming.destroy();
      return;
    }
    const status = incoming.statusCode ?? 502;
    if (status === 401 || status === 403) {
      auditWrite('refused', status);
      fail('REMOTE_UPSTREAM_AUTH', `The Host answered ${status}.`);
      return;
    }
    auditWrite(status < 400 ? 'ok' : 'error', status);
    try {
      stream.sendResponse({ status, headers: filterResponseHeaders(incoming.headers) });
    } catch {
      fail('REMOTE_INTERNAL', 'The Host response could not be relayed.');
      return;
    }
    incoming.on('data', (chunk: Buffer) => {
      if (!stream.writeBody(chunk) && !stream.closed) incoming.pause();
    });
    incoming.on('end', () => {
      responseEnded = true;
      stream.writeBody(EMPTY, true);
      // The body timer no longer guards anything unless the Controller keeps its half open.
      if (!requestFinished) armBodyIdle();
    });
    incoming.on('error', () => fail('REMOTE_INTERNAL', 'The Host response was interrupted.'));
    incoming.on('close', () => {
      if (!incoming.complete) fail('REMOTE_INTERNAL', 'The Host response was interrupted.');
    });
  });
}
