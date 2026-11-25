/**
 * The Controller's HTTP/SSE proxy: `/r/<peerId>/**` (contracts sections 1, 6, 7, 9).
 *
 * Mounted BEFORE the server's global body parsers, so the request body is read here as a stream and
 * handed to the mux in chunks (a 25 MB upload is never buffered whole, and the Host receives it
 * byte for byte). Authentication is the tab token in the Authorization header and nothing else: the
 * main JWT and a token in the query string are refused, and a token for another peer is refused.
 * `/health` and `/api/auth/user|status` are answered here from the token (the Host would refuse
 * `/api/auth/**`). Everything else must pass the same route policy the Host applies (an early 403,
 * the Host still re-checks) and then travels over the link as a canonical target with only the
 * allow-listed headers; the tab token never leaves this process.
 *
 * What comes back is untrusted: response headers go through the allow-list again (cookies,
 * `X-Auth-Error`, redirects, the Host's own CSP are dropped; non-JSON content is sandboxed) and their
 * values must be plain header text (a CR/LF/NUL/control character fails the response with 502
 * `REMOTE_INTERNAL`, nothing is dropped silently); a Host 401/403 is a 502 `REMOTE_UPSTREAM_AUTH` and a
 * redirect (3xx other than 304) a 502 `REMOTE_INTERNAL`, both with no auth marker or `Location`; the
 * declared `Content-Length` is enforced byte for byte (a body that is longer or shorter cuts the
 * connection, so nothing can be smuggled behind it or glued to the next response); and a Host that sends
 * faster than the browser reads is cut off by the receive budgets. Nothing here logs headers, tokens or
 * bodies.
 */

import type { IncomingHttpHeaders } from 'node:http';

import express, { type Request, type Response } from 'express';
import { authenticatePreviewFrame, getSessionRuntime } from '@/modules/auth/index.js';
import { HTML_PREVIEW_CSP } from '@/modules/file-tree/index.js';

import type { RemoteBrowserConnection, RemoteErrorCode, RemoteMuxHeaders, RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { RemoteLinkDownError } from '../link/relay-link.js';
import { MuxFrameError } from '../mux/frames.js';
import { DEFAULT_MUX_LIMITS } from '../mux/stream-table.js';
import { SANDBOX_CSP, filterRequestHeaders, filterResponseHeaders, previewDocumentHeaders, withoutConditionalHeaders } from '../policy/header-filter.js';
import { evaluateRemoteHttpRequest, type RemoteHttpPolicy } from '../policy/route-allow-list.js';

import type { PeerRegistry } from './peer-registry.service.js';
import { DEFAULT_RECEIVE_BUDGET_BYTES, createReceiveLedger, resolveReceiveBudgets, type ReceiveLedger } from './receive-budget.js';
import { createRefusedUploadDrain, resolveRefusedUploadBudgets, type RefusedUploadBudgets } from './refused-upload-drain.js';
import type { TabTokenService } from './tab-token.service.js';

const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The HTML preview page path: as the route policy spells it after canonicalisation, and as an answer for it is closed by default. */
const HTML_PREVIEW_ROUTE = /^\/api\/file-tree\/projects\/[^/]+\/files\/html-preview$/i;
/** What a browser sends with every fetch and navigation; only their presence is checked for a status check of the preview page. */
const FETCH_METADATA_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'] as const;
const EMPTY = Buffer.alloc(0);
/** What Node itself accepts in a header value: tab, printable ASCII and Latin-1; no CR, LF, NUL, DEL or other controls. */
const SAFE_RESPONSE_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const STATUS_BY_CODE: Record<RemoteErrorCode, number> = {
  REMOTE_LINK_DOWN: 503,
  REMOTE_FORBIDDEN: 403,
  REMOTE_UPSTREAM_AUTH: 502,
  REMOTE_QUOTA: 429,
  REMOTE_TOO_LARGE: 413,
  REMOTE_PROTOCOL: 426,
  REMOTE_UNSUPPORTED_MODE: 409,
  REMOTE_INTERNAL: 502,
};

export type ControllerProxyOptions = {
  tabs: Pick<TabTokenService, 'authenticate'>;
  registry: Pick<PeerRegistry, 'attach' | 'trackConnection'>;
  /** Largest request body forwarded (default: the mux ceiling, 25 MiB). */
  maxRequestBodyBytes?: number;
  /** Unread bytes tolerated per response before the stream is cut (default 8 MiB). Ignored when `receiveLedger` is given. */
  receiveBudgetBytes?: number;
  /** The receive budgets shared with the WebSocket gateway (per stream, per pairing, global); a private ledger when absent. */
  receiveLedger?: ReceiveLedger;
  /** HTTP route policy for the early 403; default is the production table. Tests that use synthetic paths inject `createRemoteHttpPolicy`. */
  evaluateHttp?: RemoteHttpPolicy;
  /** Time / byte / concurrency budgets of the refused-upload drain (defaults 15 s, 128 MiB, 4 per pairing, 16 in total; env `REMOTECLI_REMOTE_REFUSED_UPLOAD_*`). */
  refusedUpload?: Partial<RefusedUploadBudgets>;
};

/** A body is not expected (and a `Content-Length` says nothing about it) for HEAD, 204 and 304. */
const hasNoBody = (method: string, status: number): boolean => method === 'HEAD' || status === 204 || status === 304;

/** The `Authorization: Bearer` value, or '' when there is none. The query string is never consulted. */
const bearerToken = (req: Request): string => {
  const header = req.headers.authorization;
  return typeof header === 'string' ? (header.split(' ')[1] ?? '') : '';
};

const sendJsonError = (res: Response, status: number, code: string, message: string): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ success: false, error: { code, message } });
};

/** Why a stream that never produced a response head ended, as the contracts-section-9 code. */
const codeForEnd = (end: RemoteStreamEnd): RemoteErrorCode => {
  if (end.cause === 'error') return end.code;
  if (end.cause === 'link-down') return 'REMOTE_LINK_DOWN';
  return 'REMOTE_INTERNAL';
};

/**
 * Creates the `/r` router. Consumed by: the Remote module's mount (server entrypoint, before the
 * global JSON/urlencoded parsers).
 */
export function createControllerProxyRoutes(options: ControllerProxyOptions): express.Router {
  const { tabs, registry } = options;
  const maxBody = options.maxRequestBodyBytes ?? DEFAULT_MUX_LIMITS.maxRequestBodyBytes;
  const evaluateHttp = options.evaluateHttp ?? evaluateRemoteHttpRequest;
  const ledger =
    options.receiveLedger ?? createReceiveLedger(resolveReceiveBudgets({}, { perStream: options.receiveBudgetBytes ?? DEFAULT_RECEIVE_BUDGET_BYTES }));
  const refusedUploads = createRefusedUploadDrain({ budgets: resolveRefusedUploadBudgets(process.env, options.refusedUpload), registry });
  const router = express.Router();

  /** `previewDocument`: the Controller itself decided that this is a signed-in browser loading the preview page into a frame. */
  const proxy = (req: Request, res: Response, peerId: string, target: string, previewDocument = false): void => {
    let link;
    try {
      link = registry.attach(peerId);
    } catch (error) {
      if (error instanceof AppError) return sendJsonError(res, error.statusCode, error.code, error.message);
      return sendJsonError(res, 503, 'REMOTE_LINK_DOWN', 'The relay link is not online.');
    }
    if (!link.sessionActive) return sendJsonError(res, 503, 'REMOTE_LINK_DOWN', 'The relay link is not online.');

    const verdict = filterRequestHeaders(req.headers as RemoteMuxHeaders);
    if (!verdict.ok) return sendJsonError(res, 403, 'REMOTE_FORBIDDEN', 'The request headers are not allowed.');
    // A frame load never asks the Host for a partial or conditional answer, so the Host cannot answer 206 or 304 to it.
    const forwardedHeaders = previewDocument ? withoutConditionalHeaders(verdict.headers) : verdict.headers;

    const declared = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
    if (declared !== undefined && declared > maxBody) {
      // The body is never forwarded: it is read and dropped within the drain budgets, then refused and the connection closed.
      return refusedUploads.refuse(req, res, peerId, () => sendJsonError(res, 413, 'REMOTE_TOO_LARGE', 'The request body is too large.'));
    }
    const hasBody = (declared !== undefined && declared > 0) || /\bchunked\b/i.test(String(req.headers['transfer-encoding'] ?? ''));

    let stream: RemoteMuxStream;
    let finished = false;
    let responseStarted = false;
    /** Bytes the Host's response body must add up to (its declared `Content-Length`), or null when nothing is enforced. */
    let declaredLength: number | null = null;
    let forwarded = 0;
    let untrack: () => void = () => undefined;
    // Unread bytes of this response count towards the per-stream, per-pairing and global receive budgets.
    const budget = ledger.track(peerId, {
      unread: () => res.writableLength,
      cancel: () => stream?.fail('REMOTE_QUOTA', 'The browser reads too slowly.'),
    });

    const connection: RemoteBrowserConnection = {
      close: () => {
        if (finished) return;
        finished = true;
        budget.release();
        stream?.cancel();
        res.destroy();
      },
    };

    /** The body does not match the declared length: end the stream and cut the connection (nothing more is written). */
    const abortMismatchedBody = (): void => {
      finished = true;
      untrack();
      budget.release();
      stream.fail('REMOTE_PROTOCOL', 'The Host sent a body that does not match its Content-Length.');
      res.destroy();
    };

    try {
      stream = link.openStream(
        { kind: 'http', meta: { method: req.method, path: target, headers: forwardedHeaders } },
        {
          onResponse: (meta) => {
            if (finished) return;
            if (meta.status < 200 || meta.status > 599) return stream.fail('REMOTE_INTERNAL', 'The Host sent an invalid status.');
            // The honest Host bridge already turns its 401/403 into this error; a Host that does not is hostile,
            // and a 401 must never reach the browser (the client would read it as the end of the Local session).
            if (meta.status === 401 || meta.status === 403) return stream.fail('REMOTE_UPSTREAM_AUTH', 'The Host refused the request.');
            // A redirect is never delivered (the allow-list drops `Location`, so it would point nowhere); 304 is a
            // conditional-request answer, not a redirect.
            if (meta.status >= 300 && meta.status < 400 && meta.status !== 304) return stream.fail('REMOTE_INTERNAL', 'The Host answered with a redirect.');
            const headers = filterResponseHeaders(meta.headers as IncomingHttpHeaders);
            for (const value of Object.values(headers)) {
              if (typeof value === 'string' && !SAFE_RESPONSE_VALUE.test(value)) return stream.fail('REMOTE_INTERNAL', 'The Host sent an invalid response header.');
            }
            // Only a 200 for the frame load the Controller itself recognised gets the script-enabled policy of the page.
            // Every other answer for the page route already carries the plain sandbox (set when the request arrived).
            const delivered = previewDocument && meta.status === 200 ? previewDocumentHeaders(headers, HTML_PREVIEW_CSP) : headers;
            const contentLength = delivered['content-length'];
            declaredLength = typeof contentLength === 'string' && !hasNoBody(req.method, meta.status) ? Number(contentLength) : null;
            responseStarted = true;
            res.statusCode = meta.status;
            for (const [name, value] of Object.entries(delivered)) {
              if (value !== undefined) res.setHeader(name, value);
            }
            res.flushHeaders();
          },
          onBody: (chunk, fin) => {
            if (finished) return;
            if (!responseStarted) return stream.fail('REMOTE_INTERNAL', 'The Host sent a body before the response.');
            if (chunk.length > 0) {
              if (declaredLength !== null && forwarded + chunk.length > declaredLength) return abortMismatchedBody();
              forwarded += chunk.length;
              res.write(chunk);
              budget.enforce();
              if (finished) return; // the budget cut this stream
            }
            if (fin) {
              if (declaredLength !== null && forwarded !== declaredLength) return abortMismatchedBody();
              finished = true;
              untrack();
              budget.release();
              res.end();
            }
          },
          onPause: () => req.pause(),
          onResume: () => req.resume(),
          onClosed: (end) => {
            untrack();
            budget.release();
            if (finished) return;
            finished = true;
            if (responseStarted) {
              res.destroy(); // a truncated body must not look complete
              return;
            }
            const code = codeForEnd(end);
            const answer = (): void => sendJsonError(res, STATUS_BY_CODE[code], code, end.cause === 'error' ? end.message : 'The request could not be completed.');
            if (end.cause === 'error' && end.origin === 'local' && code === 'REMOTE_TOO_LARGE') refusedUploads.refuse(req, res, peerId, answer);
            else answer();
          },
        },
      );
    } catch (error) {
      budget.release();
      if (error instanceof RemoteLinkDownError) return sendJsonError(res, 503, 'REMOTE_LINK_DOWN', 'The relay link is not online.');
      // Only a target the mux cannot encode is the browser's fault; ids that ran out or a table that closed
      // mean the session has to be re-established, which the browser retries.
      if (error instanceof MuxFrameError) return sendJsonError(res, 400, 'REMOTE_BAD_REQUEST', 'The request cannot be forwarded.');
      return sendJsonError(res, 503, 'REMOTE_LINK_DOWN', 'The relay link is not online.');
    }
    untrack = registry.trackConnection(peerId, connection);

    // A write that races a dying socket may surface here; the 'close' below does the cleanup.
    res.on('error', () => undefined);
    res.on('close', () => {
      budget.release();
      if (finished || res.writableFinished) return;
      finished = true;
      untrack();
      stream.cancel();
    });

    if (!hasBody) {
      stream.writeBody(EMPTY, true);
      return;
    }
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      received += chunk.length;
      if (received > maxBody) {
        req.removeAllListeners('data');
        stream.fail('REMOTE_TOO_LARGE', 'The request body is too large.');
        return;
      }
      if (!stream.writeBody(chunk)) req.pause();
    });
    req.on('end', () => {
      if (!finished) stream.writeBody(EMPTY, true);
    });
    req.on('error', () => connection.close(0, 'request-error'));
  };

  router.use('/:peerId', (req, res) => {
    const { peerId } = req.params;
    if (!PEER_ID_PATTERN.test(peerId)) {
      res.status(404).json({ success: false, error: { code: 'REMOTE_PEER_NOT_FOUND', message: 'No such paired Host.' } });
      return;
    }
    // `req.url` is what follows `/r/<peerId>`: the path and query as the browser wrote them.
    const raw = req.url;
    const pathOnly = raw.split('?', 1)[0];
    // Every answer for the preview page route starts closed, our own JSON errors included: the plain sandbox. Only the
    // 200 of a signed-in frame load replaces it (see `previewDocumentHeaders`).
    if (HTML_PREVIEW_ROUTE.test(pathOnly)) res.setHeader('Content-Security-Policy', SANDBOX_CSP);

    // One request is authenticated by the browser's session cookie instead of a tab token: the browser loading the
    // HTML preview page into a frame of the app. `frame` is null for every other request, which keeps the tab token
    // and nothing else. The answers below are JSON with no cookie and no auth marker, as on the tab token path.
    const frame = authenticatePreviewFrame({ method: req.method, headers: req.headers, socket: req.socket, secure: req.secure }, pathOnly);
    let identity: { id: number; username: string; sessionId: string };
    if (frame) {
      if (!frame.ok) {
        sendJsonError(res, frame.status, frame.code, frame.message);
        return;
      }
      identity = frame.user;
    } else {
      const auth = tabs.authenticate(bearerToken(req), peerId);
      if (!auth.ok) {
        // No `X-Auth-Error`: a tab's 401 means "renew the tab token", never "the Local session ended".
        const expired = auth.reason === 'expired';
        sendJsonError(res, 401, expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID', expired ? 'The tab token expired.' : 'Invalid tab token.');
        return;
      }
      identity = auth.user;
    }

    const runtime = getSessionRuntime();
    runtime.store.touch(identity.sessionId, req.get('user-agent'));
    const releaseSession = runtime.connections.track(identity.sessionId, () => res.destroy());
    res.once('close', releaseSession);
    res.once('finish', releaseSession);
    if (res.destroyed) return;

    if (req.method === 'GET') {
      if (pathOnly === '/health') {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
        return;
      }
      if (pathOnly === '/api/auth/user') {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ user: { id: identity.id, username: identity.username } });
        return;
      }
      if (pathOnly === '/api/auth/status') {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ needsSetup: false, isAuthenticated: true });
        return;
      }
    }

    const decision = evaluateHttp(req.method, raw);
    if (!decision.allowed) {
      sendJsonError(res, 403, 'REMOTE_FORBIDDEN', 'This request is not available through Remote.');
      return;
    }
    // A status check of the preview page (a fetch with the tab token) is refused when the browser sends no Fetch
    // Metadata, as on Local, so the app falls back to displaying the HTML instead of loading a frame that would be
    // refused. Only the presence of the headers is checked: a fetch sends other values than a frame load.
    if (!frame && req.method === 'GET' && HTML_PREVIEW_ROUTE.test(decision.canonical.path)
      && FETCH_METADATA_HEADERS.some((name) => typeof req.headers[name] !== 'string')) {
      sendJsonError(res, 400, 'HTML_PREVIEW_FETCH_METADATA_REQUIRED', 'This browser does not send Fetch Metadata.');
      return;
    }
    proxy(req, res, peerId, `${decision.canonical.path}${decision.canonical.query}`, frame !== null);
  });

  return router;
}
