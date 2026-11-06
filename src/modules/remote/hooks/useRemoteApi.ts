import { parseRemoteAuditPage } from '@/modules/remote/utils/parse-remote-audit';
import {
  parseAnySuccess,
  parseHostPairing,
  parseHostPairingStart,
  parseJoinProgress,
  parseJoinStart,
  parseRelayConfig,
  parseRevokeResult,
  parseSasConfirmation,
} from '@/modules/remote/utils/parse-remote-responses';
import { isPasswordLockout, isWrongPassword, readRemoteResult } from '@/modules/remote/utils/remote-api-result';
import { api } from '@/shared/api';
import type {
  RemoteApiResult,
  RemoteAuditPage,
  RemoteAuditQuery,
  RemoteHostPairing,
  RemoteHostPairingStart,
  RemoteJoinProgress,
  RemoteRelayConfig,
  RemoteSasConfirmation,
} from '@/shared/types';

const remoteActions = {
  loadRelayConfig: (): Promise<RemoteApiResult<RemoteRelayConfig>> =>
    readRemoteResult(() => api.remote.relayConfig(), parseRelayConfig),
  saveRelayConfig: (url: string, secret: string, password: string): Promise<RemoteApiResult<true>> =>
    readRemoteResult(() => api.remote.saveRelayConfig(url, secret, password), parseAnySuccess),
  setAccept: (enabled: boolean, autoOffHours: number | undefined, password: string): Promise<RemoteApiResult<true>> =>
    readRemoteResult(() => api.remote.setHostAccept(enabled, autoOffHours, password), parseAnySuccess),
  startPairing: (password: string): Promise<RemoteApiResult<RemoteHostPairingStart>> =>
    readRemoteResult(() => api.remote.startHostPairing(password), parseHostPairingStart),
  readPairing: (pairingId: string): Promise<RemoteApiResult<RemoteHostPairing>> =>
    readRemoteResult(() => api.remote.hostPairing(pairingId), parseHostPairing),
  confirmSas: (pairingId: string, sas: string): Promise<RemoteApiResult<RemoteSasConfirmation>> =>
    readRemoteResult(() => api.remote.confirmHostPairing(pairingId, sas), parseSasConfirmation),
  disconnectController: (pairingId: string): Promise<RemoteApiResult<true>> =>
    readRemoteResult(() => api.remote.disconnectController(pairingId), parseAnySuccess),
  revokeController: (pairingId: string, password: string): Promise<RemoteApiResult<{ relayConfirmed: boolean }>> =>
    readRemoteResult(() => api.remote.revokeHostPairing(pairingId, password), parseRevokeResult),
  /** Read-only, no password: one page of the Host's audit log, newest first. */
  loadAudit: (query: RemoteAuditQuery = {}): Promise<RemoteApiResult<RemoteAuditPage>> =>
    readRemoteResult(() => api.remote.audit(query), parseRemoteAuditPage),
  joinHost: (code: string, deviceName: string): Promise<RemoteApiResult<string>> =>
    readRemoteResult(() => api.remote.joinPeer(code, deviceName), parseJoinStart),
  readJoin: (joinId: string): Promise<RemoteApiResult<RemoteJoinProgress>> =>
    readRemoteResult(() => api.remote.joinProgress(joinId), parseJoinProgress),
  forgetPeer: (peerId: string): Promise<RemoteApiResult<true>> =>
    readRemoteResult(() => api.remote.forgetPeer(peerId), parseAnySuccess),
  setPeerAlias: (peerId: string, alias: string | null): Promise<RemoteApiResult<true>> =>
    readRemoteResult(() => api.remote.setPeerAlias(peerId, alias), parseAnySuccess),
  /** Whether a failed result of a `*` action means the typed password was wrong (403 AUTH_INVALID_CREDENTIALS, or 401). */
  isWrongPassword,
  /** Whether a failed result of a `*` action means the password attempts are locked out (429). */
  isPasswordLockout,
};

/**
 * Typed access to the `/api/remote/*` management API (contracts.md section 2) for
 * the Remote screens. Every action resolves to a `RemoteApiResult` instead of
 * throwing. Actions marked `*` in the contract take the password as their last
 * argument; it is passed straight to the request and kept nowhere.
 * It is a hook so components get it the usual way; it holds no state.
 * Used by every component and dialog of the remote module.
 */
export const useRemoteApi = () => remoteActions;
