import type {
  RemoteHostController,
  RemoteHostPairing,
  RemoteHostPairingStart,
  RemoteHostStatus,
  RemoteJoinProgress,
  RemoteRelayConfig,
  RemoteSasConfirmation,
} from '@/shared/types';

// What the management API sends is unchecked JSON that ends up on screen and in
// URLs, so each parser keeps only well-formed fields and returns null for a
// body that is not the shape the contract (contracts.md section 2) describes.

export type Raw = Record<string, unknown>;

export const asObject = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asTime = (value: unknown): string | number | null =>
  typeof value === 'string' || typeof value === 'number' ? value : null;

/** `GET /relay-config` body; null when `url`, `hasSecret` or `masterKeySource` are not usable. */
export const parseRelayConfig = (body: unknown): RemoteRelayConfig | null => {
  const raw = asObject(body);
  if (!raw || typeof raw.url !== 'string' || typeof raw.hasSecret !== 'boolean') return null;
  if (raw.masterKeySource !== 'env' && raw.masterKeySource !== 'file') return null;
  return { url: raw.url, hasSecret: raw.hasSecret, masterKeySource: raw.masterKeySource };
};

const parseController = (entry: unknown): RemoteHostController | null => {
  const raw = asObject(entry);
  if (!raw) return null;
  const pairingId = asString(raw.pairingId) ?? asString(raw.id);
  const name = asString(raw.name) ?? asString(raw.deviceName);
  if (!pairingId || name === null) return null;
  const suspendedUntil = asTime(raw.suspendedUntil);
  return {
    pairingId,
    name,
    // A pairing is taken as linked unless the server says otherwise.
    connected: raw.connected !== false,
    connectedAt: asTime(raw.connectedAt),
    streams: asNumber(raw.streams) ?? asNumber(raw.streamCount) ?? 0,
    ...(suspendedUntil !== null ? { suspendedUntil } : {}),
  };
};

/** `GET /host/status` body; null when `acceptEnabled` is missing. Malformed controller entries are dropped. */
export const parseHostStatus = (body: unknown): RemoteHostStatus | null => {
  const raw = asObject(body);
  if (!raw || typeof raw.acceptEnabled !== 'boolean') return null;
  const relay = asObject(raw.relay);
  const controllers = Array.isArray(raw.controllers)
    ? raw.controllers.flatMap((entry) => parseController(entry) ?? [])
    : [];
  return {
    acceptEnabled: raw.acceptEnabled,
    autoOffHours: asNumber(raw.autoOffHours) ?? 0,
    autoOffAt: asTime(raw.autoOffAt),
    relayState: asString(relay?.state) ?? 'unknown',
    approvalTimeoutMs: asNumber(raw.approvalTimeoutMs),
    controllers,
  };
};

/** `POST /host/pairings/start` body. */
export const parseHostPairingStart = (body: unknown): RemoteHostPairingStart | null => {
  const raw = asObject(body);
  const pairingId = asString(raw?.pairingId);
  const code = asString(raw?.code);
  const expiresAt = asTime(raw?.expiresAt);
  return pairingId && code && expiresAt !== null ? { pairingId, code, expiresAt } : null;
};

const HOST_PAIRING_STATES: ReadonlySet<string> = new Set(['waiting-controller', 'awaiting-sas', 'done', 'failed']);

/** `GET /host/pairings/:pairingId` body. */
export const parseHostPairing = (body: unknown): RemoteHostPairing | null => {
  const raw = asObject(body);
  if (!raw || typeof raw.state !== 'string' || !HOST_PAIRING_STATES.has(raw.state)) return null;
  return {
    state: raw.state as RemoteHostPairing['state'],
    controllerName: asString(raw.controllerName),
    attemptsLeft: asNumber(raw.attemptsLeft),
    lockedUntil: asTime(raw.lockedUntil),
  };
};

/** `POST /host/pairings/:pairingId/confirm` body: `{ ok: true }` or `{ ok: false, attemptsLeft }`. */
export const parseSasConfirmation = (body: unknown): RemoteSasConfirmation | null => {
  const raw = asObject(body);
  if (!raw || typeof raw.ok !== 'boolean') return null;
  return { ok: raw.ok, attemptsLeft: asNumber(raw.attemptsLeft), lockedUntil: asTime(raw.lockedUntil) };
};

/** `POST /peers/join` body: the id to follow the join with. */
export const parseJoinStart = (body: unknown): string | null => asString(asObject(body)?.joinId) || null;

/** `GET /peers/join/:joinId` body; `sas` is kept only when it is exactly six digits. */
export const parseJoinProgress = (body: unknown): RemoteJoinProgress | null => {
  const raw = asObject(body);
  const state = asString(raw?.state);
  if (!raw || !state) return null;
  const sas = asString(raw.sas);
  return {
    state,
    sas: sas !== null && /^\d{6}$/.test(sas) ? sas : null,
    peerId: asString(raw.peerId),
    failure: asString(raw.failure),
  };
};

/** `DELETE /host/pairings/:pairingId` body: whether the relay confirmed the revocation. */
export const parseRevokeResult = (body: unknown): { relayConfirmed: boolean } | null => {
  const raw = asObject(body);
  return raw ? { relayConfirmed: raw.relayConfirmed === true } : null;
};

/** For endpoints whose answer carries nothing the UI needs: any 2xx is success. */
export const parseAnySuccess = (): true => true;
