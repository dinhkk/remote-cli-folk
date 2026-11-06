/**
 * The Remote module as the server entrypoint sees it: `createRemoteModule` is called while the Express
 * app is built, `mount(app)` goes right after `cors()` and BEFORE the global body parsers, `websocket` and
 * `authEpoch` are handed to the WebSocket gateway, and `start()` runs once the database is open.
 *
 * Why the early mount: the global `express.json({limit:'50mb'})` reads a body before any route could
 * stream it. `/r` must see the raw request (a 25 MB upload goes through in chunks, a JSON body reaches the
 * Host byte for byte) and `/api/remote` has its own 4 KB parser, so both are registered ahead of it, and
 * ahead of the static handler and the SPA catch-all (which would answer `/r/x/api/health` with index.html).
 *
 * Modes: `CLOUDCLI_REMOTE_DISABLED` mounts nothing and opens nothing (the server behaves as before Remote
 * existed); platform mode and a Controller with `API_KEY` mount `/api/remote` so the UI can say why it is
 * unavailable, answer 409 `REMOTE_UNSUPPORTED_MODE`, and never mount `/r`; a master key that changed or
 * vanished is also a status (409 `MASTER_KEY_MISMATCH`), not a crash.
 */

import net from 'node:net';

import type { Express, NextFunction, Request, Response } from 'express';

import { authenticateToken, onAuthEpochChange, validateApiKey, verifyPassword } from '@/modules/auth/index.js';
import type { RemoteAuthEpochHook, RemoteWebSocketGateway } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createRemoteRoutes } from '../api/remote.routes.js';
import { createManagementGuards } from '../api/remote-guards.js';
import { createControllerProxyRoutes } from '../controller/controller-proxy.routes.js';
import { createRemoteWebSocketGateway } from '../controller/controller-ws-proxy.service.js';
import type { PeerRegistry } from '../controller/peer-registry.service.js';
import type { TabTokenService } from '../controller/tab-token.service.js';
import { RemoteLinkDownError } from '../link/relay-link.js';
import { detectUnsupportedRemoteMode } from '../policy/remote-mode-policy.js';
import { SecretBoxError } from '../crypto/secret-box.js';
import { initializeRemoteStorage, isRelayConfigured, shouldOpenRemoteStorageAtStart } from '../storage/remote-storage.service.js';

import { createDormantManagement } from './dormant-management.js';
import { createMainPageSecurityHeaders, resolveMainPageHeaderOptions } from './main-page-security-headers.js';
import { createRemoteRuntime, type RemoteRuntime, type RemoteRuntimeOptions } from './remote-runtime.service.js';
import type { RemoteManagement } from './remote-management.service.js';
import { TARGET_PAGE_CSP, createTargetPageCsp } from './target-page-csp.js';

export { TARGET_PAGE_CSP };

const isTruthy = (value: string | undefined): boolean => ['1', 'true'].includes(value?.trim().toLowerCase() ?? '');

/**
 * The address the Host bridge calls this server on: loopback unless the server is bound to one specific
 * IP address, in which case only that address accepts connections (binding `192.168.1.5` does not listen
 * on 127.0.0.1). Wildcards (`0.0.0.0`, `::`), host names and nothing at all mean loopback.
 */
export const resolveBridgeHost = (bindHost: string | undefined): string | undefined => {
  const host = bindHost?.trim();
  if (!host || net.isIP(host) === 0) return undefined;
  if (host === '0.0.0.0' || /^(0*:)+0*$/.test(host)) return undefined;
  return host;
};

export type RemoteModuleOptions = {
  appVersion: string;
  /** `SERVER_PORT` the server listens on. */
  port: number;
  /** `HOST` the server binds to, as configured. */
  bindHost?: string;
  env?: NodeJS.ProcessEnv;
  /** Built `index.html`: its inline scripts are allowed by hash in the CSP of `?target=` pages. */
  indexHtmlPath?: string;
  /** Test seams of the running parts (relay sockets, clock, accept persistence). */
  runtime?: Pick<RemoteRuntimeOptions, 'socketFactory' | 'pairConnector' | 'clock' | 'settings' | 'hostName' | 'auditRepository'>;
};

export type RemoteModule = {
  /** False when `CLOUDCLI_REMOTE_DISABLED` is set. */
  readonly enabled: boolean;
  /** Registers `/api/remote`, `/r` and the `?target=` CSP; call after `cors()` and before the body parsers. */
  mount(app: Express): void;
  /** `/r/**` WebSocket handling for `createWebSocketServer`; undefined when `/r` is not available. */
  readonly websocket: RemoteWebSocketGateway | undefined;
  readonly authEpoch: RemoteAuthEpochHook;
  /** Opens the storage (master key) and restores Accept; never throws for a Remote problem. */
  start(): void;
  stop(): void;
};

/**
 * Creates the Remote module.
 * Consumed by: `server/index.ts`.
 */
export function createRemoteModule(options: RemoteModuleOptions): RemoteModule {
  const env = options.env ?? process.env;
  const enabled = !isTruthy(env.CLOUDCLI_REMOTE_DISABLED);
  const controllerAvailable = enabled && detectUnsupportedRemoteMode('controller', env) === null;
  const anyRoleAvailable = enabled && (controllerAvailable || detectUnsupportedRemoteMode('host', env) === null);

  let runtime: RemoteRuntime | null = null;
  /**
   * Why Remote cannot work until the operator acts (unsupported mode, master key changed/invalid/missing): kept
   * for the life of the process, because retrying would fail the same way and a new key must never be generated
   * behind sealed data. A transient failure to open the storage (disk full, locked database) is NOT recorded
   * here: the next call that needs the storage tries again.
   */
  let blocked: AppError | null = enabled && !anyRoleAvailable ? unsupportedError() : null;
  /** The last transient failure to open the storage; while set, management calls retry instead of answering as an unused install. */
  let openFailure: AppError | null = null;
  let stopEpochListener: (() => void) | undefined;

  function unsupportedError(): AppError {
    return new AppError('Remote cannot run in this mode.', { statusCode: 409, code: 'REMOTE_UNSUPPORTED_MODE' });
  }

  // The proxy and the gateway are built before the database is open; they reach the runtime through these.
  const tabs: Pick<TabTokenService, 'authenticate'> = {
    authenticate: (token, peerId) => runtime?.tabs.authenticate(token, peerId) ?? { ok: false, reason: 'invalid' },
  };
  const registry: Pick<PeerRegistry, 'attach' | 'trackConnection'> = {
    attach(peerId) {
      if (!runtime) throw new RemoteLinkDownError();
      return runtime.registry.attach(peerId);
    },
    trackConnection: (peerId, connection) => runtime?.registry.trackConnection(peerId, connection) ?? (() => undefined),
  };

  let started = false;

  /**
   * Opens the storage (creating the master key when there is none) and builds and starts the runtime.
   * A master key problem is remembered as the reason Remote is blocked (no key material in its message), any
   * other failure is only reported for this call (`openFailure`); both are rethrown.
   */
  const openRuntime = (): RemoteRuntime => {
    try {
      const storage = initializeRemoteStorage({ env, now: options.runtime?.clock?.now });
      const opened = createRemoteRuntime({
        storage,
        env,
        appVersion: options.appVersion,
        bridgeTarget: { port: options.port, host: resolveBridgeHost(options.bindHost) },
        ...options.runtime,
      });
      runtime = opened;
      stopEpochListener = onAuthEpochChange(() => runtime?.closeRemoteConnections());
      opened.start();
      openFailure = null;
      return opened;
    } catch (error) {
      runtime?.stop();
      stopEpochListener?.();
      stopEpochListener = undefined;
      runtime = null;
      const permanent = error instanceof SecretBoxError && error.code.startsWith('MASTER_KEY');
      const code = permanent ? error.code : 'REMOTE_START_FAILED';
      // The message of these errors never carries key material; anything else is reduced to its name.
      console.warn(`[WARN] Remote is ${permanent ? 'disabled' : 'unavailable for now'}: ${code}${error instanceof SecretBoxError ? ` (${error.message})` : ''}`);
      const failure = new AppError(permanent ? 'The Remote master key changed or is missing.' : 'Remote could not start. Try again.', { statusCode: 409, code });
      if (permanent) blocked = failure;
      else openFailure = failure;
      throw failure;
    }
  };

  /** The runtime, opened now if Remote had not been used yet; throws why Remote is blocked. */
  const ensureRuntime = (): RemoteRuntime => {
    if (blocked) throw blocked;
    return runtime ?? openRuntime();
  };

  // Until Remote is used the storage stays closed: no key file and no `remote.*` rows for a Local-only user.
  const dormant = createDormantManagement({
    env,
    ensure: () => ensureRuntime().management,
    hostSupported: () => enabled && detectUnsupportedRemoteMode('host', env) === null,
    controllerSupported: () => controllerAvailable,
    // A relay URL AND secret must be saved. Settings that cannot be read refuse the call before anything is opened
    // (reading them as "not configured" would be wrong, and opening the storage would create a key on a sick database).
    relayConfigured: () => {
      try {
        return isRelayConfigured();
      } catch {
        throw new AppError('Remote settings could not be read. Try again.', { statusCode: 409, code: 'REMOTE_START_FAILED' });
      }
    },
  });

  const resolveManagement = (): RemoteManagement => {
    if (blocked) throw blocked;
    if (runtime) return runtime.management;
    if (!started) throw new AppError('Remote is starting.', { statusCode: 503, code: 'REMOTE_LINK_DOWN' });
    // Opening the storage failed earlier for a reason that may have gone away: try again rather than answer "unused".
    if (openFailure) return ensureRuntime().management;
    return dormant;
  };

  const websocket = controllerAvailable ? createRemoteWebSocketGateway({ tabs, registry }) : undefined;

  const mainPageHeaders = createMainPageSecurityHeaders(resolveMainPageHeaderOptions(env));
  const targetPageCsp = createTargetPageCsp(options.indexHtmlPath);
  const targetPageCspMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // `target` present in any form (`?target=`, repeated): the page may run with a Remote tab token.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.query.target !== undefined && !/\.[a-z0-9]+$/i.test(req.path.replace(/\.html$/i, ''))) {
      res.setHeader('Content-Security-Policy', targetPageCsp());
    }
    next();
  };

  return {
    enabled,
    websocket,
    authEpoch: {
      subscribe: onAuthEpochChange,
      // With JWT_SECRET pinned in the environment the main login survives "log out everywhere"; only Remote ends.
      closesRegularSockets: () => !process.env.JWT_SECRET,
    },

    mount(app) {
      if (!enabled) return;
      app.use(mainPageHeaders);
      app.use(targetPageCspMiddleware);
      const guards = createManagementGuards({ authenticateToken, validateApiKey, verifyPassword });
      app.use('/api/remote', createRemoteRoutes({ guards, resolveManagement }));
      if (controllerAvailable) app.use('/r', createControllerProxyRoutes({ tabs, registry }));
    },

    start() {
      if (!enabled || blocked) return;
      started = true;
      if (!shouldOpenRemoteStorageAtStart({ env })) return; // first use opens it (ensureRuntime)
      try {
        openRuntime();
      } catch {
        // recorded in `blocked`; the management API reports it
      }
    },

    stop() {
      stopEpochListener?.();
      stopEpochListener = undefined;
      runtime?.stop();
    },
  };
}
