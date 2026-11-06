/**
 * In-memory `RemotePairingStore` for tests of the services that use pairings (registry, Host accept,
 * revocation). It keeps K in the clear in memory (no sealing: that is the store's own test) and models
 * the revoke semantics: `k_sealed` gone, a pending-destroy record kept until cleared.
 */

import crypto from 'node:crypto';

import type { RemoteNewPairing, RemotePairingRecord, RemotePairingRole, RemotePairingStore, RemotePendingDestroy } from '@/shared/types.js';

import { deriveLinkKeys } from '../../crypto/key-derivation.js';

export type MemoryPairingStore = RemotePairingStore & {
  /** Convenience for arranging a test: inserts a pairing with a random K and returns it. */
  add(input: { role: RemotePairingRole; name?: string; relayUrl?: string; id?: string; expiresAt?: number | null; k?: Buffer }): RemotePairingRecord;
  keys: Map<string, Buffer>;
  calls: string[];
  failOpenKeyFor: Set<string>;
};

export const createMemoryPairingStore = (now: () => number = Date.now): MemoryPairingStore => {
  const rows = new Map<string, RemotePairingRecord>();
  const keys = new Map<string, Buffer>();
  const pending = new Map<string, RemotePendingDestroy>();
  const calls: string[] = [];
  const failOpenKeyFor = new Set<string>();

  const store: MemoryPairingStore = {
    keys,
    calls,
    failOpenKeyFor,
    add({ role, name = 'Device', relayUrl = 'wss://relay.test', id = crypto.randomUUID(), expiresAt = null, k = crypto.randomBytes(32) }) {
      return store.insertPairing({ id, role, peerName: name, k, relayUrl, expiresAt });
    },
    insertPairing(input: RemoteNewPairing) {
      const id = input.id ?? crypto.randomUUID();
      const record: RemotePairingRecord = {
        id,
        role: input.role,
        peerName: input.peerName,
        alias: null,
        roomId: deriveLinkKeys(input.k).roomId,
        relayUrl: input.relayUrl,
        createdAt: now(),
        lastConnectedAt: null,
        lastActivityAt: null,
        revokedAt: null,
        expiresAt: input.expiresAt ?? null,
        pendingDestroy: false,
      };
      rows.set(id, record);
      keys.set(id, Buffer.from(input.k));
      return { ...record };
    },
    getPairing: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    listPairings: (role) => [...rows.values()].filter((row) => role === undefined || row.role === role).map((row) => ({ ...row })).reverse(),
    countActivePairings: (role) => [...rows.values()].filter((row) => row.role === role && row.revokedAt === null).length,
    openPairingKey(id) {
      calls.push(`openPairingKey:${id}`);
      const k = keys.get(id);
      if (failOpenKeyFor.has(id) || !k || rows.get(id)?.revokedAt !== null) throw new Error('Pairing key unavailable.');
      return Buffer.from(k);
    },
    revokeHostPairing(id) {
      calls.push(`revoke:${id}`);
      const row = rows.get(id);
      const k = keys.get(id);
      if (!row || row.role !== 'host' || row.revokedAt !== null || !k) throw new Error('Cannot revoke.');
      const { roomId, hostToken } = deriveLinkKeys(k);
      pending.set(id, { id, roomId, hostToken });
      keys.delete(id);
      row.revokedAt = now();
      row.pendingDestroy = true;
      return { ...row };
    },
    deletePairing(id) {
      calls.push(`delete:${id}`);
      rows.delete(id);
      keys.delete(id);
    },
    setPairingAlias(id, alias) {
      calls.push(`alias:${id}`);
      const row = rows.get(id);
      if (!row) throw new Error('Unknown pairing.');
      row.alias = alias;
      return { ...row };
    },
    listPendingDestroy: () => [...pending.values()],
    clearPendingDestroy(id) {
      calls.push(`clearPending:${id}`);
      pending.delete(id);
      const row = rows.get(id);
      if (row) row.pendingDestroy = false;
    },
    markConnected(id, options) {
      calls.push(`markConnected:${id}`);
      const row = rows.get(id);
      if (row) {
        row.lastConnectedAt = now();
        if (options?.renewActivity !== false) row.lastActivityAt = now();
      }
    },
    touchActivity(id) {
      calls.push(`touchActivity:${id}`);
      const row = rows.get(id);
      if (row) row.lastActivityAt = now();
    },
    expirePairing(id) {
      calls.push(`expire:${id}`);
      const row = rows.get(id);
      if (!row) throw new Error('Unknown pairing.');
      const k = keys.get(id);
      if (row.role === 'host' && row.revokedAt === null && k) {
        const { roomId, hostToken } = deriveLinkKeys(k);
        pending.set(id, { id, roomId, hostToken });
        row.revokedAt = now();
        row.pendingDestroy = true;
      }
      keys.delete(id);
      row.expiresAt = Math.min(row.expiresAt ?? now(), now());
      return { ...row };
    },
  };
  return store;
};
