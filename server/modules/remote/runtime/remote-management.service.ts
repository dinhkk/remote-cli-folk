/**
 * What the management API (`/api/remote/**`) does, one method per endpoint of contracts section 2/10, so
 * the routes stay "parse, call, answer". The checks that depend on the machine live here: a mode that
 * cannot run Remote answers 409 `REMOTE_UNSUPPORTED_MODE` (a Controller with `API_KEY` can still be a
 * Host), and pairing needs a saved relay URL and secret (400 `REMOTE_NOT_CONFIGURED`).
 *
 * Answers contain ids, names, states, a pairing code and a SAS, never K, host/controller tokens or the
 * relay secret: those never leave the services below.
 */

import type {
  RemoteAuditPage,
  RemoteHostPairingStatus,
  RemotePairingFailure,
  RemotePeerView,
  RemoteHostStatusView,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { MAX_AUDIT_PAGE, type AuditService } from '../audit/audit.service.js';
import type { createControllerPairingService } from '../pairing/pairing-controller.service.js';
import { PairingError, type createHostPairingService } from '../pairing/pairing-host.service.js';
import type { PeerRegistry } from '../controller/peer-registry.service.js';
import type { TabTokenService } from '../controller/tab-token.service.js';
import type { HostAcceptService } from '../host/host-accept.service.js';

import type { RelayConfigView, RelaySettingsService } from './relay-settings.service.js';

export type RemoteManagementOptions = {
  relay: RelaySettingsService;
  hostAccept: HostAcceptService;
  hostPairing: ReturnType<typeof createHostPairingService>;
  controllerPairing: ReturnType<typeof createControllerPairingService>;
  registry: PeerRegistry;
  tabs: TabTokenService;
  audit: Pick<AuditService, 'list'>;
  /** True when both the relay URL and the secret are saved. */
  isConfigured(): boolean;
  hostSupported(): boolean;
  controllerSupported(): boolean;
};

/**
 * Contracts section 10: the join/pairing failure is a stable code, never free text. Reasons that mean
 * "start over with a fresh code" map to the same few codes the UI knows.
 */
export const pairingFailureCode = (failure: RemotePairingFailure): string => {
  switch (failure) {
    case 'expired':
    case 'code-used-or-expired':
      return 'REMOTE_PAIR_EXPIRED';
    case 'code-not-found':
      return 'REMOTE_PAIR_CODE_INVALID';
    case 'limit-reached':
      return 'REMOTE_PAIR_FULL';
    case 'sas-attempts-exhausted':
    case 'relay-locked':
      return 'REMOTE_PAIR_LOCKED';
    default:
      return 'REMOTE_PAIR_FAILED';
  }
};

const unsupported = (message: string): AppError => new AppError(message, { statusCode: 409, code: 'REMOTE_UNSUPPORTED_MODE' });
const notConfigured = (): AppError => new AppError('Save the relay URL and secret first.', { statusCode: 400, code: 'REMOTE_NOT_CONFIGURED' });
const badRequest = (message: string): AppError => new AppError(message, { statusCode: 400, code: 'REMOTE_BAD_REQUEST' });

/** Longest alias of a Host, counted in characters. */
export const MAX_PEER_ALIAS_LENGTH = 40;
/** Control, zero-width and bidi-override characters: they could hide or reorder what a tab shows. */
const INVISIBLE_OR_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/**
 * The alias a user gives a Host, ready to store: one line, no invisible or control characters, spaces
 * collapsed. Blank text or null clears the alias. Too long is refused rather than cut, so what the user
 * typed is never silently changed.
 */
export const normalizePeerAlias = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw badRequest('alias must be text or null.');
  const cleaned = value.replace(INVISIBLE_OR_CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  if ([...cleaned].length > MAX_PEER_ALIAS_LENGTH) throw badRequest(`alias must be at most ${MAX_PEER_ALIAS_LENGTH} characters.`);
  return cleaned;
};
const pairNotFound = (): PairingError => new PairingError('PAIRING_NOT_FOUND', 'No such pairing in progress.');

/** A whole number from a query string (`?limit=20`), or a 400 naming the parameter. */
const queryNumber = (value: unknown, name: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  return parsed;
};

/** Validates `?limit=&before=&controller=` of the audit endpoint (anything else in the query is ignored). */
export const parseAuditQuery = (query: { limit?: unknown; before?: unknown; controller?: unknown }) => {
  const controller = query.controller;
  if (controller !== undefined && (typeof controller !== 'string' || controller === '' || controller.length > 64)) {
    throw badRequest('controller must be a pairing id.');
  }
  return {
    limit: queryNumber(query.limit, 'limit', 1, MAX_AUDIT_PAGE),
    before: queryNumber(query.before, 'before', 0, Number.MAX_SAFE_INTEGER),
    controller: controller as string | undefined,
  };
};

/**
 * Creates the management service.
 * Consumed by: the management routes.
 */
export function createRemoteManagement(options: RemoteManagementOptions) {
  const { relay, hostAccept, hostPairing, controllerPairing, registry, tabs } = options;

  const requireHost = (): void => {
    if (!options.hostSupported()) throw unsupported('Remote cannot run in this mode.');
  };
  const requireController = (): void => {
    if (!options.controllerSupported()) throw unsupported('Remote cannot run as a Controller while API_KEY is set (or in platform mode).');
  };
  const requireConfigured = (): void => {
    if (!options.isConfigured()) throw notConfigured();
  };
  const requireText = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value === '') throw badRequest(`${name} is required.`);
    return value;
  };

  /** The Host's view of a pairing with the failure as a code (the UI also reads `attemptsLeft` and `lockedUntil`). */
  const hostPairingView = (status: RemoteHostPairingStatus): Omit<RemoteHostPairingStatus, 'failure'> & { failure?: string } => {
    const { failure, ...rest } = status;
    return failure ? { ...rest, failure: pairingFailureCode(failure) } : rest;
  };

  return {
    relayConfig(): RelayConfigView {
      return relay.view();
    },
    updateRelayConfig: (input: { url?: unknown; secret?: unknown }): Promise<{ revocationFailures: number }> => relay.update(input),

    hostStatus(): RemoteHostStatusView {
      requireHost();
      return hostAccept.status();
    },
    setAccept(input: { enabled?: unknown; autoOffHours?: unknown }): RemoteHostStatusView {
      requireHost();
      if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false.');
      return hostAccept.setAccept({ enabled: input.enabled, autoOffHours: input.autoOffHours as number | undefined });
    },

    /** The Host's audit (FR-42), newest first, paged by id cursor, optionally for one Controller. Read-only. */
    hostAudit(query: { limit?: unknown; before?: unknown; controller?: unknown }): RemoteAuditPage {
      requireHost();
      return options.audit.list(parseAuditQuery(query));
    },

    startHostPairing(): { pairingId: string; code: string; expiresAt: number } {
      requireHost();
      requireConfigured();
      return hostPairing.start();
    },
    hostPairingStatus(pairingId: string) {
      requireHost();
      const status = hostPairing.getStatus(pairingId);
      if (!status) throw pairNotFound();
      // A finished pairing needs its link now: Accept is on and the Controller expects to connect.
      if (status.state === 'done') hostAccept.syncLinks();
      return hostPairingView(status);
    },
    confirmPairing(pairingId: string, sas: unknown): { ok: true } | { ok: false; attemptsLeft: number; lockedUntil?: number } {
      requireHost();
      const outcome = hostPairing.confirmSas(pairingId, requireText(sas, 'sas'));
      if (outcome.ok) return outcome;
      // The third wrong entry locks the Host; the UI shows until when.
      const lockedUntil = outcome.attemptsLeft === 0 ? hostPairing.getStatus(pairingId)?.lockedUntil : undefined;
      return lockedUntil === undefined ? outcome : { ...outcome, lockedUntil };
    },
    disconnectController(pairingId: string): { ok: true } {
      requireHost();
      hostAccept.disconnect(pairingId);
      return { ok: true };
    },
    async revokePairing(pairingId: string): Promise<{ ok: true; relayConfirmed: boolean }> {
      requireHost();
      return hostAccept.revoke(pairingId);
    },

    listPeers(): RemotePeerView[] {
      requireController();
      return registry.listPeers();
    },
    joinPeer(input: { code?: unknown; deviceName?: unknown }): { joinId: string } {
      requireController();
      requireConfigured();
      return controllerPairing.join({ code: requireText(input.code, 'code'), deviceName: requireText(input.deviceName, 'deviceName') });
    },
    joinStatus(joinId: string) {
      requireController();
      const status = controllerPairing.getStatus(joinId);
      if (!status) throw pairNotFound();
      const { failure, ...rest } = status;
      return failure ? { ...rest, failure: pairingFailureCode(failure) } : rest;
    },
    forgetPeer(peerId: string): { ok: true } {
      requireController();
      registry.forget(peerId);
      return { ok: true };
    },
    setPeerAlias(peerId: string, input: { alias?: unknown } | undefined): { ok: true; alias: string | null } {
      requireController();
      // `{}` is a mistake, not a request to clear the name: clearing is explicit (null or blank text).
      if (!input || typeof input !== 'object' || !('alias' in input)) throw badRequest('alias is required (text, or null to clear it).');
      const normalized = normalizePeerAlias(input.alias);
      registry.setAlias(peerId, normalized);
      return { ok: true, alias: normalized };
    },
    issueTabToken(user: { id: number; username: string }, peerId: string): { tabToken: string; expiresAt: number } {
      requireController();
      return tabs.issue({ userId: user.id, username: user.username, peerId });
    },
  };
}

export type RemoteManagement = ReturnType<typeof createRemoteManagement>;
