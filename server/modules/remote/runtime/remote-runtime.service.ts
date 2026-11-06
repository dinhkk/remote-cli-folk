/**
 * Assembles the running parts of Remote once the storage is open: the Controller's peer registry and tab
 * tokens, the Host's Accept service with its bridges and the DESTROY retrier, the pairing services and the
 * management service on top. Everything that touches the network (relay sockets, pairing rooms) can be
 * replaced for tests through `socketFactory` / `pairConnector`.
 *
 * Lifetime: `start()` restores Accept (if it was on and has not expired) and starts the DESTROY retrier;
 * `stop()` closes every link. Nothing here keeps the process alive on its own (timers are unref'd).
 */

import { remoteAuditDb, remoteConfigDb } from '@/modules/database/index.js';
import type { RemoteClock, RemotePairConnector, RemotePairingStore, RemoteRelaySocketFactory } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createAuditService, type AuditRepository } from '../audit/audit.service.js';
import { createWriteErrorLogger } from '../audit/audit-write-error-log.js';
import { createHostBridge } from '../bridge/host-bridge.js';
import { createPeerRegistry } from '../controller/peer-registry.service.js';
import { createTabTokenService } from '../controller/tab-token.service.js';
import { createHostAcceptService, type AcceptSettings } from '../host/host-accept.service.js';
import { createPendingDestroyRetrier } from '../host/pending-destroy-retrier.js';
import { createRelayDestroyClient } from '../host/relay-destroy-client.js';
import { createRelayLink } from '../link/relay-link.js';
import { createRelayPairConnector } from '../link/pair-connector.js';
import { createControllerPairingService } from '../pairing/pairing-controller.service.js';
import { systemClock } from '../pairing/pairing-clock.js';
import { createPairingExpiryService, resolveIdleDays } from '../pairing/pairing-expiry.service.js';
import { createHostPairingService } from '../pairing/pairing-host.service.js';
import { detectUnsupportedRemoteMode } from '../policy/remote-mode-policy.js';
import { createPairingQuota } from '../quota/pairing-quota.service.js';
import type { createRemoteConfigService } from '../storage/remote-storage.service.js';

import { resolveAuditRetentionDays, resolveQuotaLimitsFromEnv, resolveQuotaSuspendMs } from './remote-hardening-config.js';
import { createRemoteManagement } from './remote-management.service.js';
import { createRelaySettingsService } from './relay-settings.service.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 55_000;

/** The effective `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` the Host status reports (FR-31). */
export const resolveApprovalTimeoutMs = (env: NodeJS.ProcessEnv): number =>
  Number.parseInt(env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || DEFAULT_APPROVAL_TIMEOUT_MS;
/** Close code for browser sockets of a login that "log out everywhere" ended. */
const SESSION_ENDED_CLOSE_CODE = 4401;

export type RemoteRuntimeOptions = {
  storage: {
    config: ReturnType<typeof createRemoteConfigService>;
    pairings: RemotePairingStore;
    keySource: 'env' | 'file';
  };
  env: NodeJS.ProcessEnv;
  appVersion: string;
  /** Where the Host bridge calls this server (see `resolveBridgeHost`). */
  bridgeTarget: { port: number; host?: string };
  clock?: RemoteClock;
  /** Persistence of the Accept switch (default: the throwing `remote.*` config repository). */
  settings?: AcceptSettings;
  /** Replaces the real relay WebSocket for links, DESTROY and (unless `pairConnector` is given) pairing rooms. */
  socketFactory?: RemoteRelaySocketFactory;
  pairConnector?: RemotePairConnector;
  hostName?: string;
  /** Replaces the `remote_audit` repository (tests only). */
  auditRepository?: AuditRepository;
};

/** A pairing's activity mark is written at most this often (the idle limit is measured in days). */
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60_000;

/**
 * Creates the running Remote parts.
 * Consumed by: the Remote module (`start()`).
 */
export function createRemoteRuntime(options: RemoteRuntimeOptions) {
  const { storage, env } = options;
  const { config, pairings } = storage;
  const clock = options.clock ?? systemClock;
  const settings = options.settings ?? remoteConfigDb;
  const hostSupported = (): boolean => detectUnsupportedRemoteMode('host', env) === null;
  const controllerSupported = (): boolean => detectUnsupportedRemoteMode('controller', env) === null;

  /** The saved secret, or null: a blob that cannot be opened must not take the server down. */
  const relaySecret = (): string | null => {
    try {
      return config.getRelaySecret();
    } catch {
      return null;
    }
  };
  const isConfigured = (): boolean => {
    try {
      return Boolean(config.getRelayUrl()) && relaySecret() !== null;
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------------- hardening: audit, idle expiry, quota

  // Windows of the quota, suspensions and the log rate limit use a MONOTONIC clock, so a wall-clock step (NTP, a
  // VM resume) can neither hold streams out nor shorten a suspension. An injected test clock stands in for both.
  const monotonicNow: () => number = options.clock ? options.clock.now : () => performance.now();

  const audit = createAuditService({
    repository: options.auditRepository ?? remoteAuditDb,
    clock,
    retentionDays: resolveAuditRetentionDays(env),
    // A failed audit write never fails a request, but it must not be invisible: its error NAME is logged, at most once a minute.
    onWriteError: createWriteErrorLogger({ now: monotonicNow, warn: (line) => console.warn(line) }),
  });
  const quotaLimits = resolveQuotaLimitsFromEnv(env);
  const quotaSuspendMs = resolveQuotaSuspendMs(env);
  const expiry = createPairingExpiryService({
    store: pairings,
    clock,
    idleDays: resolveIdleDays(env.CLOUDCLI_REMOTE_PAIRING_IDLE_DAYS),
    onControllerExpired: (record) => registry.dropExpired(record.id),
    expireHostPairings: () => hostAccept.expireIdlePairings(),
  });

  // ---------------------------------------------------------------- Controller side

  const registry = createPeerRegistry({
    store: pairings,
    expiry,
    getRelaySecret: relaySecret,
    isSupported: controllerSupported,
    clock,
    appVersion: options.appVersion,
    createLink: (linkOptions) => createRelayLink({ ...linkOptions, socketFactory: options.socketFactory }),
  });
  const tabs = createTabTokenService({ hasPeer: registry.hasPeer });

  // ---------------------------------------------------------------- Host side

  const destroyClient = createRelayDestroyClient({ socketFactory: options.socketFactory, clock });
  const retrier = createPendingDestroyRetrier({ store: pairings, destroyClient, getRelaySecret: relaySecret, clock });
  const hostAccept = createHostAcceptService({
    store: pairings,
    settings,
    getRelaySecret: relaySecret,
    isSupported: hostSupported,
    clock,
    monotonicNow,
    appVersion: options.appVersion,
    // The mux keeps its own stream cap as a backstop, a little above the quota, so that the pairing quota (which audits) refuses first.
    createLink: (linkOptions) =>
      createRelayLink({
        ...linkOptions,
        limits: { ...linkOptions.limits, maxOpenStreams: quotaLimits.maxStreams + 16 },
        socketFactory: options.socketFactory,
      }),
    // One bridge, one quota and one audit subject per Controller. Nothing is written to the log (refused paths are hostile input);
    // policy refusals and everything else go to the audit table, which masks secrets and cuts lengths.
    createBridge: ({ pairingId, name }) => {
      const subject = { pairingId, label: name };
      let lastActivityWrite = Number.NEGATIVE_INFINITY;
      return createHostBridge({
        port: options.bridgeTarget.port,
        host: options.bridgeTarget.host,
        env,
        quota: createPairingQuota({
          limits: quotaLimits,
          clock: { now: monotonicNow },
          onViolationLimit: () => hostAccept.suspend(pairingId, quotaSuspendMs),
        }),
        onViolation: (violation) =>
          audit.record(subject, {
            event: 'policy-deny',
            target: `${violation.method ?? ''} ${violation.target ?? ''}`.trim() || violation.kind,
            result: 'refused',
            detail: { kind: violation.kind, reason: violation.reason },
          }),
        onAudit: (event) => audit.record(subject, event),
        onActivity: () => {
          if (clock.now() - lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
          lastActivityWrite = clock.now();
          pairings.touchActivity(pairingId);
        },
      });
    },
    pendingDestroy: retrier,
    approvalTimeoutMs: () => resolveApprovalTimeoutMs(env),
    audit,
    expiry,
  });

  // ---------------------------------------------------------------- pairing

  const connect: RemotePairConnector = (target, handlers) => {
    if (options.pairConnector) return options.pairConnector(target, handlers);
    const relayUrl = config.getRelayUrl();
    const secret = relaySecret();
    if (!relayUrl || !secret) throw new AppError('Save the relay URL and secret first.', { statusCode: 400, code: 'REMOTE_NOT_CONFIGURED' });
    return createRelayPairConnector({ relayUrl, relaySecret: secret, socketFactory: options.socketFactory })(target, handlers);
  };
  const getRelayUrl = (): string => config.getRelayUrl() ?? '';
  // A finished pairing gets its link at once while Accept is on, instead of waiting for the next status read or
  // the 60-second tick: the Controller is waiting to connect. Opening the link never fails the pairing itself.
  const hostPairingStore: RemotePairingStore = {
    ...pairings,
    insertPairing(input) {
      const record = pairings.insertPairing(input);
      if (input.role === 'host') {
        audit.record({ pairingId: record.id, label: record.peerName }, { event: 'pair', target: 'ceremony', result: 'ok' });
        try {
          hostAccept.syncLinks();
        } catch {
          // The next status read or tick tries again.
        }
      }
      return record;
    },
  };
  const hostPairing = createHostPairingService({ connect, store: hostPairingStore, getRelayUrl, hostName: options.hostName, clock });
  const controllerPairing = createControllerPairingService({ connect, store: pairings, getRelayUrl, clock });

  // ---------------------------------------------------------------- settings and management

  /**
   * Every pairing ends: Hosts are revoked at the relay, Controllers forget theirs and close their links. One
   * that cannot be revoked never stops the others; the number left over is reported to the caller.
   */
  const revokeAllPairings = async (): Promise<{ failed: number }> => {
    let { failed } = await hostAccept.revokeAll();
    for (const record of pairings.listPairings('controller')) {
      try {
        registry.forget(record.id);
      } catch (error) {
        // "Not found" means it is already gone; anything else (the database) left the pairing in place.
        if (!(error instanceof AppError && error.statusCode === 404)) failed += 1;
      }
    }
    registry.closeLinks();
    return { failed };
  };

  const relaySettings = createRelaySettingsService({ config, masterKeySource: () => storage.keySource, revokeAll: revokeAllPairings });
  const management = createRemoteManagement({
    relay: relaySettings,
    hostAccept,
    hostPairing,
    controllerPairing,
    registry,
    tabs,
    audit,
    isConfigured,
    hostSupported,
    controllerSupported,
  });

  return {
    audit,
    expiry,
    registry,
    tabs,
    hostAccept,
    hostPairing,
    controllerPairing,
    management,
    relaySettings,
    retrier,

    /** Restores Accept and starts the DESTROY retries (one run right away for what a restart left pending). */
    start(): void {
      hostAccept.restore();
      retrier.start();
      void retrier.runOnce().catch(() => undefined);
      audit.start();
      expiry.start();
    },

    /** "Log out everywhere": every browser connection through Remote and every bridged stream ends. */
    closeRemoteConnections(): void {
      registry.closeConnections(undefined, SESSION_ENDED_CLOSE_CODE, 'session-ended');
      hostAccept.closeStreams();
    },

    stop(): void {
      expiry.stop();
      audit.stop();
      retrier.stop();
      hostAccept.stop();
      registry.closeLinks();
    },
  };
}

export type RemoteRuntime = ReturnType<typeof createRemoteRuntime>;
