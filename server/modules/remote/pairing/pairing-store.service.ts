/**
 * Pairing store: `remote_pairings` rows with the pairing key K sealed at rest.
 *
 * K is sealed with the secret box under the AAD `remote_pairings|k_sealed|<id>|v1`, so a blob
 * copied to another row (or column) fails to open. A revoked Host pairing loses K for good and
 * keeps only `{roomId, hostToken}` sealed, which is what retrying the relay DESTROY needs. The
 * database layer sees opaque blobs; this service is the only place that opens them.
 */

import crypto from 'node:crypto';

import { remotePairingsDb } from '@/modules/database/index.js';
import type {
  RemoteNewPairing,
  RemotePairingRecord,
  RemotePairingRole,
  RemotePairingRow,
  RemotePairingStore,
  RemotePendingDestroy,
} from '@/shared/types.js';

import { deriveLinkKeys } from '../crypto/key-derivation.js';
import { secretAad, type SecretBox } from '../crypto/secret-box.js';

const K_BYTES = 32;

const kAad = (id: string): string => secretAad('remote_pairings', 'k_sealed', id);
const pendingDestroyAad = (id: string): string => secretAad('remote_pairings', 'pending_destroy_sealed', id);

const toRecord = (row: RemotePairingRow): RemotePairingRecord => ({
  id: row.id,
  role: row.role,
  peerName: row.peer_name,
  alias: row.alias ?? null,
  roomId: row.room_id,
  relayUrl: row.relay_url,
  createdAt: row.created_at,
  lastConnectedAt: row.last_connected_at,
  lastActivityAt: row.last_activity_at,
  revokedAt: row.revoked_at,
  expiresAt: row.expires_at,
  pendingDestroy: row.pending_destroy_sealed !== null,
});

type PairingStoreOptions = {
  /** Secret box built from the resolved master key. */
  box: SecretBox;
  /** Epoch-millisecond clock; injectable for tests. */
  now?: () => number;
  /** A pending-destroy row could not be opened or parsed and was skipped (id only; diagnostics). */
  onSkippedPendingDestroy?: (id: string) => void;
};

/**
 * Creates the pairing store over the shared database connection.
 * Consumed by: the Remote host/controller pairing services, `initializeRemoteStorage`.
 */
export const createPairingStore = ({ box, now = Date.now, onSkippedPendingDestroy }: PairingStoreOptions): RemotePairingStore => {
  const requireRow = (id: string): RemotePairingRow => {
    const row = remotePairingsDb.getById(id);
    if (!row) throw new Error('Unknown pairing.');
    return row;
  };

  const openK = (row: RemotePairingRow): Buffer => {
    if (row.revoked_at !== null || !row.k_sealed) throw new Error('Pairing is revoked: its key has been erased.');
    return box.open(row.k_sealed, kAad(row.id));
  };

  return {
    insertPairing(input: RemoteNewPairing) {
      if (!(input.k instanceof Uint8Array) || input.k.length !== K_BYTES) throw new Error(`Pairing key must be ${K_BYTES} bytes.`);
      const id = input.id ?? crypto.randomUUID();
      const row: RemotePairingRow = {
        id,
        role: input.role,
        peer_name: input.peerName,
        alias: null,
        k_sealed: box.seal(input.k, kAad(id)),
        pending_destroy_sealed: null,
        room_id: deriveLinkKeys(input.k).roomId,
        relay_url: input.relayUrl,
        created_at: now(),
        last_connected_at: null,
        last_activity_at: null,
        revoked_at: null,
        expires_at: input.expiresAt ?? null,
      };
      remotePairingsDb.insert(row);
      return toRecord(row);
    },

    getPairing(id) {
      const row = remotePairingsDb.getById(id);
      return row ? toRecord(row) : null;
    },

    listPairings(role?: RemotePairingRole) {
      return remotePairingsDb.list(role).map(toRecord);
    },

    countActivePairings(role) {
      return remotePairingsDb.countActive(role);
    },

    openPairingKey(id) {
      return openK(requireRow(id));
    },

    revokeHostPairing(id) {
      const row = requireRow(id);
      if (row.role !== 'host') throw new Error('Only Host pairings can be revoked; a Controller deletes its pairing instead.');
      if (row.revoked_at !== null) throw new Error('Pairing is already revoked.');
      const k = openK(row);
      const { roomId, hostToken } = deriveLinkKeys(k);
      k.fill(0);
      const pending = box.seal(JSON.stringify({ roomId, hostToken }), pendingDestroyAad(id));
      if (!remotePairingsDb.revoke(id, now(), pending)) throw new Error('Pairing is already revoked.');
      return toRecord(requireRow(id));
    },

    deletePairing(id) {
      remotePairingsDb.delete(id);
    },

    setPairingAlias(id, alias) {
      if (!remotePairingsDb.setAlias(id, alias)) throw new Error('Unknown pairing.');
      return toRecord(requireRow(id));
    },

    listPendingDestroy(): RemotePendingDestroy[] {
      const pending: RemotePendingDestroy[] = [];
      for (const row of remotePairingsDb.listPendingDestroy()) {
        // One corrupt or foreign row must not block the DESTROY retries of every other revoked pairing.
        try {
          const parsed = JSON.parse(box.open(row.pending_destroy_sealed as Buffer, pendingDestroyAad(row.id)).toString('utf8')) as Partial<
            Record<'roomId' | 'hostToken', unknown>
          >;
          if (typeof parsed.roomId !== 'string' || typeof parsed.hostToken !== 'string') throw new Error('Unexpected pending-destroy record.');
          pending.push({ id: row.id, roomId: parsed.roomId, hostToken: parsed.hostToken });
        } catch {
          onSkippedPendingDestroy?.(row.id); // the id only: neither the blob nor any error text can carry a secret out
        }
      }
      return pending;
    },

    clearPendingDestroy(id) {
      remotePairingsDb.clearPendingDestroy(id);
    },

    markConnected(id, options) {
      remotePairingsDb.markConnected(id, now(), options?.renewActivity !== false);
    },

    touchActivity(id) {
      remotePairingsDb.touchActivity(id, now());
    },

    expirePairing(id) {
      const row = requireRow(id);
      // A Host pairing still owes the relay a DESTROY: revoking seals `{roomId, hostToken}` before K goes.
      if (row.role === 'host' && row.revoked_at === null) {
        if (row.k_sealed) {
          const k = openK(row);
          const { roomId, hostToken } = deriveLinkKeys(k);
          k.fill(0);
          remotePairingsDb.revoke(id, now(), box.seal(JSON.stringify({ roomId, hostToken }), pendingDestroyAad(id)));
        } else {
          remotePairingsDb.revoke(id, now(), null);
        }
      }
      remotePairingsDb.markExpired(id, now());
      return toRecord(requireRow(id));
    },
  };
};
