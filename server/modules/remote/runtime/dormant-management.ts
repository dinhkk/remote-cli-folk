/**
 * What the management API answers while Remote has not been used yet (no master key file, no relay settings,
 * no pairings): the empty state, without opening the storage. Opening it creates `remote-master.key` and the
 * `remote.master_key_id` row, which a Local-only user must never get just because the server started.
 *
 * Reads answer as an unused install would (no relay, Accept off, no peers, nothing to find). Saving relay
 * settings opens the storage through `ensure()` and is then handled by the real management service. The
 * calls that need a configured relay (switching Accept ON, starting a Host pairing, joining one) check that
 * FIRST: unless the relay URL and the secret are both saved they are refused (400 `REMOTE_NOT_CONFIGURED`) and
 * the storage stays closed, so a refused call never leaves a master key behind. If the settings cannot be read
 * the call is refused as well (`relayConfigured` throws) and nothing is opened.
 */

import type { RemoteHostStatusView } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { PairingError } from '../pairing/pairing-host.service.js';

import { parseAuditQuery, type RemoteManagement } from './remote-management.service.js';
import { resolveApprovalTimeoutMs } from './remote-runtime.service.js';

export type DormantManagementOptions = {
  env: NodeJS.ProcessEnv;
  /** Opens the storage (creating the master key if needed) and returns the real management service; throws the blocking `AppError` when that fails. */
  ensure(): RemoteManagement;
  hostSupported(): boolean;
  controllerSupported(): boolean;
  /**
   * True once a relay URL AND secret are saved; false until then (nothing that needs a relay can work yet).
   * Throws when the settings cannot be read: the caller's call is then refused and nothing is opened or written.
   */
  relayConfigured(): boolean;
};

const notConfigured = (): AppError => new AppError('Save the relay URL and secret first.', { statusCode: 400, code: 'REMOTE_NOT_CONFIGURED' });
const unsupported = (message: string): AppError => new AppError(message, { statusCode: 409, code: 'REMOTE_UNSUPPORTED_MODE' });
const noSuchPeer = (): AppError => new AppError('No such paired Host.', { statusCode: 404, code: 'REMOTE_PEER_NOT_FOUND' });
const noSuchControllerPairing = (): AppError => new AppError('No such Controller pairing.', { statusCode: 404, code: 'REMOTE_PAIR_NOT_FOUND' });
const noSuchPairingInProgress = (): PairingError => new PairingError('PAIRING_NOT_FOUND', 'No such pairing in progress.');

/**
 * Creates the management service of an unused Remote.
 * Consumed by: the Remote module, until the first call that needs the storage.
 */
export function createDormantManagement({ env, ensure, hostSupported, controllerSupported, relayConfigured }: DormantManagementOptions): RemoteManagement {
  const requireHost = (): void => {
    if (!hostSupported()) throw unsupported('Remote cannot run in this mode.');
  };
  const requireController = (): void => {
    if (!controllerSupported()) throw unsupported('Remote cannot run as a Controller while API_KEY is set (or in platform mode).');
  };

  const emptyHostStatus = (): RemoteHostStatusView => {
    requireHost();
    return { acceptEnabled: false, autoOffHours: 0, autoOffAt: null, relay: { state: 'stopped' }, approvalTimeoutMs: resolveApprovalTimeoutMs(env), controllers: [] };
  };

  return {
    relayConfig: () => ({ url: '', hasSecret: false, masterKeySource: 'file' }),
    updateRelayConfig: (input) => ensure().updateRelayConfig(input),

    hostStatus: emptyHostStatus,
    hostAudit(query) {
      requireHost();
      parseAuditQuery(query); // a malformed query is refused the same way as by the real service
      return { entries: [], nextBefore: null, controllers: [] };
    },
    setAccept(input) {
      requireHost();
      if (input.enabled === true) {
        if (!relayConfigured()) throw notConfigured();
        return ensure().setAccept(input);
      }
      // A malformed body is refused like the real service does, without opening anything for it.
      if (typeof input.enabled !== 'boolean') throw new AppError('enabled must be true or false.', { statusCode: 400, code: 'REMOTE_BAD_REQUEST' });
      // Switching off something that was never on changes nothing.
      return emptyHostStatus();
    },

    startHostPairing() {
      requireHost();
      if (!relayConfigured()) throw notConfigured();
      return ensure().startHostPairing();
    },
    hostPairingStatus(): never {
      requireHost();
      throw noSuchPairingInProgress();
    },
    confirmPairing(): never {
      requireHost();
      throw noSuchPairingInProgress();
    },
    disconnectController(): never {
      requireHost();
      throw noSuchControllerPairing();
    },
    revokePairing() {
      requireHost();
      return Promise.reject(noSuchControllerPairing());
    },

    listPeers() {
      requireController();
      return [];
    },
    joinPeer(input) {
      requireController();
      if (!relayConfigured()) throw notConfigured();
      return ensure().joinPeer(input);
    },
    joinStatus(): never {
      requireController();
      throw noSuchPairingInProgress();
    },
    forgetPeer(): never {
      requireController();
      throw noSuchPeer();
    },
    setPeerAlias(): never {
      requireController();
      throw noSuchPeer();
    },
    issueTabToken(): never {
      requireController();
      throw noSuchPeer();
    },
  };
}
