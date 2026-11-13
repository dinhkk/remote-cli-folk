/**
 * Host bridge (FR-36/37/38, contracts sections 3, 6, 7): turns mux streams opened by a remote
 * Controller into calls to the local remotecli server over loopback, and is where the Host decides what
 * a Controller may do. The Controller is never trusted: every stream passes the policy here, whatever
 * the Controller's own proxy already checked.
 *
 * This file is the wiring: options, the stream entry point (`handleStream`), `attach(link)` and the
 * violation reporting. The two halves live next to it: `bridge-http-stream.ts` (HTTP) and
 * `bridge-websocket-stream.ts` (`/ws` and `/shell`); shared limits are in `bridge-limits.ts`.
 *
 * Failures are answered with mux ERROR frames carrying the contracts section 9 code; nothing in the
 * bridge logs tokens, headers, bodies or message content. Policy refusals go to `onViolation` (reason
 * and a short path only) for the owner of the bridge to audit, behind a token bucket per link
 * (`violationBurst` / `violationsPerSecond`); reports beyond it go to `onViolationSuppressed` and are
 * counted in `suppressedViolations`.
 *
 * Scope of the policy: the deny rules and the route allow-list are SURFACE REDUCTION, not a security
 * boundary against a hostile paired Controller. Pairing is a full-trust grant (a Controller already has
 * a shell as the Host OS user through `/shell`, and the file-tree/project APIs); see
 * `REMOTE_DENY_RULES` in `policy/route-allow-list.ts`.
 *
 * Backpressure (contracts section 6): when a stream's send queue reaches 4 MiB the stream calls
 * `onPause` and the loopback socket is paused; at 1 MiB it resumes. Toward the Host the unsent bytes on
 * the loopback socket are capped (`maxUpstreamBufferedBytes`, then `REMOTE_QUOTA`).
 */

import { issueLoopbackToken } from '@/modules/auth/index.js';
import type {
  RemoteAuditEvent,
  RemoteBridgeViolation,
  RemoteMuxStream,
  RemoteRelayLink,
  RemoteStreamOpen,
  RemoteStreamQuota,
} from '@/shared/types.js';

import { detectUnsupportedRemoteMode } from '../policy/remote-mode-policy.js';
import { evaluateRemoteHttpRequest, type RemoteHttpPolicy } from '../policy/route-allow-list.js';

import { admitBridgeStream } from './bridge-admission.js';
import type { BridgeContext } from './bridge-context.js';
import { bridgeHttpStream } from './bridge-http-stream.js';
import { DEFAULT_HOST_BRIDGE_LIMITS, type HostBridgeLimits } from './bridge-limits.js';
import { bridgeWebSocketStream } from './bridge-websocket-stream.js';
import { createLoopbackClient, resolveLoopbackPort } from './loopback-client.js';
import { createViolationRateLimiter, type ViolationRateLimiter } from './violation-rate-limiter.js';

export type { HostBridgeLimits } from './bridge-limits.js';

/**
 * Options of a Host bridge. Defaults are the production wiring: `SERVER_PORT` from the environment,
 * the real loopback token from the auth module, the process environment for `API_KEY` and the mode
 * check. Tests inject all of them.
 */
// Consumed by: the Host side of the remote module (phase 08 wiring), bridge tests.
export type HostBridgeOptions = {
  port?: number;
  /** IP literal of the local server (default `127.0.0.1`); see `LoopbackClientOptions.host`. */
  host?: string;
  env?: NodeJS.ProcessEnv;
  /** Must return a NEW token on every call; called once per HTTP request and once per WebSocket. */
  issueToken?: () => string;
  /** Called for every policy refusal the rate limit lets through (audit). A throwing reporter is ignored. */
  onViolation?: (violation: RemoteBridgeViolation) => void;
  /**
   * Called instead of `onViolation` for refusals beyond the rate limit. Must be cheap (a counter, no
   * audit write). The pairing quota (`quota.noteViolation`) is told of every such refusal by the bridge itself.
   */
  onViolationSuppressed?: (violation: RemoteBridgeViolation) => void;
  limits?: Partial<HostBridgeLimits>;
  /** HTTP route policy; default is the production table (`evaluateRemoteHttpRequest`). Tests that use synthetic paths inject `createRemoteHttpPolicy`. */
  evaluateHttp?: RemoteHttpPolicy;
  /** Clock of the violation rate limiter in milliseconds (default: monotonic). Tests inject it. */
  now?: () => number;
  /**
   * Per-pairing stream quota (FR-39). Without one nothing is limited here (the mux still caps a link at 64
   * streams). A refused stream is answered `ERROR REMOTE_QUOTA` and reported through `onAudit`.
   */
  quota?: RemoteStreamQuota;
  /**
   * Audit events of the streams served (approval decisions, terminal open/close, file writes, quota refusals).
   * Raw short strings only: the receiver sanitises. A throwing receiver is ignored. Never receives file contents.
   */
  onAudit?: (event: RemoteAuditEvent) => void;
  /** A stream was admitted: the pairing is in use (renews idle expiry). Called at most once per stream; must be cheap. */
  onActivity?: () => void;
};

/** A Host bridge: install `handleStream` (or `attach` a link) to serve a Controller's streams. */
// Consumed by: the Host side of the remote module (phase 08 wiring), bridge tests.
export type HostBridge = {
  /**
   * Serves one stream the Controller opened. Installs the stream's handlers synchronously. Violations
   * share one bucket for the whole bridge; use `attach` to get one bucket per link.
   */
  handleStream(stream: RemoteMuxStream, open: RemoteStreamOpen): void;
  /** Serves every stream of `link` while its E2E session is active (otherwise `REMOTE_LINK_DOWN`); returns the unsubscribe. */
  attach(link: Pick<RemoteRelayLink, 'onStream' | 'sessionActive'>): () => void;
  /** Streams currently being served. */
  readonly activeStreams: number;
  /** Violation reports dropped by the rate limiter so far (all links). */
  readonly suppressedViolations: number;
  /** Cancels every active stream (Accept switched off, pairing revoked). */
  closeAll(): void;
};

/**
 * Creates the Host bridge of one pairing (or one shared bridge). Consumed by: the Host side of the
 * remote module (phase 08 wires it to each Host `RelayLink` and calls `closeAll` on Accept off,
 * revoke and epoch change).
 */
export function createHostBridge(options: HostBridgeOptions = {}): HostBridge {
  const env = options.env ?? process.env;
  const port = options.port ?? resolveLoopbackPort(env);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The loopback port is not valid');
  const limits: HostBridgeLimits = { ...DEFAULT_HOST_BRIDGE_LIMITS, ...options.limits };
  const client = createLoopbackClient({ port, host: options.host, env, issueToken: options.issueToken ?? issueLoopbackToken });
  const active = new Set<RemoteMuxStream>();
  let suppressedTotal = 0;

  const newLimiter = (): ViolationRateLimiter =>
    createViolationRateLimiter({ burst: limits.violationBurst, perSecond: limits.violationsPerSecond, now: options.now });

  const contextFor = (limiter: ViolationRateLimiter): BridgeContext => ({
    client,
    evaluateHttp: options.evaluateHttp ?? evaluateRemoteHttpRequest,
    limits,
    active,
    report: (violation) => {
      const allowed = limiter.tryConsume();
      if (!allowed) suppressedTotal += 1;
      try {
        // A flood of denials past the audit rate limit is evidence nobody reads any more: it counts against
        // the pairing instead (more than the quota's violations per minute suspends it).
        if (!allowed) options.quota?.noteViolation?.();
        (allowed ? options.onViolation : options.onViolationSuppressed)?.(violation);
      } catch {
        // A broken reporter must never take the bridge down.
      }
    },
    audit: (event) => {
      try {
        options.onAudit?.(event);
      } catch {
        // An audit receiver that throws must never fail the request being audited.
      }
    },
  });

  const serve = (context: BridgeContext, stream: RemoteMuxStream, open: RemoteStreamOpen): void => {
    if (detectUnsupportedRemoteMode('host', env) !== null) {
      stream.fail('REMOTE_UNSUPPORTED_MODE', 'Remote is not supported in this server mode.');
      return;
    }
    const lifecycle = admitBridgeStream({ quota: options.quota, audit: context.audit, onActivity: options.onActivity }, stream, open);
    if (!lifecycle) return; // refused by the pairing quota (already answered and audited)
    if (open.kind === 'http') bridgeHttpStream(context, stream, open.meta, lifecycle);
    else bridgeWebSocketStream(context, stream, open.meta, lifecycle);
    // A stream refused on the spot never installed a handler, so nobody else would free its slot.
    if (stream.closed) lifecycle.ended();
  };

  const sharedContext = contextFor(newLimiter());

  return {
    handleStream: (stream, open) => serve(sharedContext, stream, open),
    attach: (link) => {
      const linkContext = contextFor(newLimiter());
      return link.onStream((stream, open) => {
        if (!link.sessionActive) return 'REMOTE_LINK_DOWN';
        serve(linkContext, stream, open);
        return undefined;
      });
    },
    get activeStreams() {
      return active.size;
    },
    get suppressedViolations() {
      return suppressedTotal;
    },
    closeAll() {
      for (const stream of [...active]) stream.cancel();
    },
  };
}
