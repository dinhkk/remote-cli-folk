import { asNumber, asObject, asString } from '@/modules/remote/utils/parse-remote-responses';
import type { RemoteAuditController, RemoteAuditEntry, RemoteAuditPage } from '@/shared/types';

// The audit comes from a possibly hostile Controller (labels, targets and command
// text are its own words), so each parser keeps only well-formed fields and drops
// a whole entry rather than guess. Nothing here throws.

/** Most detail keys kept per entry; the server sends a handful, so a longer object is not trusted. */
const MAX_DETAIL_KEYS = 20;

const parseDetail = (value: unknown): RemoteAuditEntry['detail'] => {
  const detail: RemoteAuditEntry['detail'] = {};
  const raw = asObject(value);
  if (!raw) return detail;
  for (const [key, item] of Object.entries(raw).slice(0, MAX_DETAIL_KEYS)) {
    if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      detail[key] = item;
    }
  }
  return detail;
};

const parseEntry = (value: unknown): RemoteAuditEntry | null => {
  const raw = asObject(value);
  if (!raw) return null;
  const id = asNumber(raw.id);
  const at = asNumber(raw.at);
  const controller = asString(raw.controller);
  const event = asString(raw.event);
  const target = asString(raw.target);
  const result = asString(raw.result);
  if (id === null || at === null || controller === null || event === null || target === null || result === null) {
    return null;
  }
  // `pairingId` is a string, or null for an event no pairing owns; anything else is malformed.
  if (raw.pairingId !== null && raw.pairingId !== undefined && typeof raw.pairingId !== 'string') return null;
  return { id, at, pairingId: asString(raw.pairingId), controller, event, target, result, detail: parseDetail(raw.detail) };
};

const parseController = (value: unknown): RemoteAuditController | null => {
  const raw = asObject(value);
  const pairingId = asString(raw?.pairingId);
  const label = asString(raw?.label);
  return pairingId && label !== null ? { pairingId, label } : null;
};

/** `GET /host/audit` body; null when `entries` is not a list. Malformed entries and Controllers are dropped. */
export const parseRemoteAuditPage = (body: unknown): RemoteAuditPage | null => {
  const raw = asObject(body);
  if (!raw || !Array.isArray(raw.entries)) return null;
  return {
    entries: raw.entries.flatMap((entry) => parseEntry(entry) ?? []),
    nextBefore: asNumber(raw.nextBefore),
    controllers: Array.isArray(raw.controllers) ? raw.controllers.flatMap((item) => parseController(item) ?? []) : [],
  };
};
