/**
 * Remote module barrel. Only what other modules need is exported; everything else (crypto,
 * ceremony state machines, frame codec) stays module-private. Entries are added in phase order.
 */

// Phase 05 (pairing): consumed by the management API and server start-up (phase 08).
export { initializeRemoteStorage, RemoteConfigError } from '@/modules/remote/storage/remote-storage.service.js';
export { createHostPairingService, PairingError } from '@/modules/remote/pairing/pairing-host.service.js';
export { createControllerPairingService } from '@/modules/remote/pairing/pairing-controller.service.js';
// Errors the management API maps to HTTP answers: bad code input, and a master key that must keep Remote disabled.
export { InvalidPairCodeError } from '@/modules/remote/crypto/key-derivation.js';
export { SecretBoxError } from '@/modules/remote/crypto/secret-box.js';

// Phase 06 (relay link + mux): consumed by the Host bridge (phase 07) and the Controller proxy (phase 08).
// One authenticated, encrypted link per paired peer: open/close it, open mux streams, subscribe to state events.
export { createRelayLink, REMOTE_PROTOCOL_VERSION, RemoteLinkDownError, toRemotePeerState } from '@/modules/remote/link/relay-link.js';
// Real `ws` socket factory (default for links) and the pairing-room connector the pairing services use.
export { createWsRelaySocketFactory } from '@/modules/remote/link/relay-socket.js';
export { createRelayPairConnector } from '@/modules/remote/link/pair-connector.js';
// Mux limits (stream queue, chunk sizes) so callers can read the documented defaults.
export { DEFAULT_MUX_LIMITS } from '@/modules/remote/mux/stream-table.js';

// Phase 07 (Host bridge + policy): consumed by the Host side of the remote module (phase 08) and by the
// Controller proxy, which may pre-check a request for an early 403 (the Host always re-checks).
// The bridge serves a Controller's mux streams on the Host: allow-list, header filter, loopback calls.
export { createHostBridge } from '@/modules/remote/bridge/host-bridge.js';
export type { HostBridge, HostBridgeOptions, HostBridgeLimits } from '@/modules/remote/bridge/host-bridge.js';
// Route policy: the single allow/deny table plus the evaluators (phase 12 sweeps every mounted route through classifyRoute).
export { classifyRoute, createRemoteHttpPolicy, evaluateRemoteHttpRequest, evaluateRemoteWebSocketTarget } from '@/modules/remote/policy/route-allow-list.js';
export type { RemoteHttpPolicy } from '@/modules/remote/policy/route-allow-list.js';
// Modes where Remote refuses to run (platform mode; a Controller with API_KEY): used when enabling Remote.
export { detectUnsupportedRemoteMode } from '@/modules/remote/policy/remote-mode-policy.js';
export type { RemoteUnsupportedMode } from '@/modules/remote/policy/remote-mode-policy.js';

// Phase 08 (Controller proxy, management API, Host accept): the server entrypoint builds the module once,
// mounts it after cors() and before the global body parsers, and hands `websocket` / `authEpoch` to the
// WebSocket gateway (which never imports this module).
export { createRemoteModule, resolveBridgeHost, TARGET_PAGE_CSP } from '@/modules/remote/runtime/remote.module.js';
export type { RemoteModule, RemoteModuleOptions } from '@/modules/remote/runtime/remote.module.js';

// Shared at-rest storage for browser MFA and Remote credentials.
export { getMasterSecret } from './storage/master-secret.service.js';
export { secretAad, createSecretBox } from './crypto/secret-box.js';
export type { SecretBox } from './crypto/secret-box.js';
