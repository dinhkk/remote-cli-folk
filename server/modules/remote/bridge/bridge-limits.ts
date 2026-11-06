/**
 * Limits and constants shared by the Host bridge's HTTP and WebSocket halves. Every limit has a safe
 * default (`DEFAULT_HOST_BRIDGE_LIMITS`) and can be overridden through `HostBridgeOptions.limits`.
 */

/** WebSocket close code for "this message/path is not allowed by Host policy" (contracts section 9). */
export const WS_POLICY_CLOSE = 4403;
/** WebSocket close code for "overloaded" (contracts section 6). */
export const WS_OVERLOAD_CLOSE = 1013;
/** Messages the Controller sends before the loopback socket is open are held in order, up to this count. */
export const MAX_PENDING_WEBSOCKET_MESSAGES = 256;

/** Time and size limits of the bridge. */
// Consumed by: host-bridge (options), bridge-http-stream, bridge-websocket-stream, bridge tests.
export type HostBridgeLimits = {
  /** Longest silence while a request body is still expected (slow-loris on the upload). Default 120 s. */
  requestBodyIdleMs: number;
  /**
   * Longest wait for the Host to start answering once the request body was handed over (the clock
   * starts when the last body byte is written, so a Host that stops reading the upload is cut too).
   * Default 10 min. A long git operation (`clone`, `push`, `pull` of a big repository) answers its HTTP
   * request only when it finishes: raise this on Hosts that run such operations through Remote.
   */
  responseHeadersMs: number;
  /** Longest wait for the loopback WebSocket upgrade. Default 10 s. */
  websocketHandshakeMs: number;
  /** Declared request body ceiling (the mux enforces the same ceiling on the bytes themselves). Default 25 MiB. */
  maxRequestBodyBytes: number;
  /** Bytes of Controller messages held while the loopback WebSocket is still opening. Default 1 MiB. */
  maxPendingWebSocketBytes: number;
  /**
   * Bytes a stream may leave unsent on the loopback socket (request body or WebSocket messages) because
   * the Host handler reads slowly. The mux has no receive-side flow control toward the Controller, so
   * past this cap the stream is cancelled with `REMOTE_QUOTA` instead of growing without bound.
   * Default 8 MiB (the mux's own per-stream queue ceiling).
   */
  maxUpstreamBufferedBytes: number;
  /**
   * Policy-violation reports (`onViolation`) are rate limited per link with a token bucket: `burst`
   * reports at once (default 20), then `violationsPerSecond` (default 1, 0 = no refill). Refused
   * streams are never limited, only the reports; the rest go to `onViolationSuppressed`.
   */
  violationBurst: number;
  violationsPerSecond: number;
};

// Consumed by: host-bridge, violation-rate-limiter tests.
export const DEFAULT_HOST_BRIDGE_LIMITS: HostBridgeLimits = {
  requestBodyIdleMs: 120_000,
  responseHeadersMs: 600_000,
  websocketHandshakeMs: 10_000,
  maxRequestBodyBytes: 25 * 1024 * 1024,
  maxPendingWebSocketBytes: 1024 * 1024,
  maxUpstreamBufferedBytes: 8 * 1024 * 1024,
  violationBurst: 20,
  violationsPerSecond: 1,
};
