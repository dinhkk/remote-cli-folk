// Shared constants and types for the relay. Single source of truth for the wire protocol is
// plans/261104-1155-cloudcli-remote-work/contracts.md section 4; the numbers here must match it.

import type { Room } from './room';

export type RoomKind = 'link' | 'pair';
export type Role = 'host' | 'controller';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  /** Shared secret for the gate HMAC. Set with `wrangler secret put RELAY_SECRET` (never in git). */
  RELAY_SECRET?: string;
}

/** WebSocket close codes (contracts section 4). */
export const CloseCode = {
  /** Wrong frame type / broken JSON after authentication. */
  BAD_FRAME: 4400,
  /**
   * Not authenticated: invalid/too long first frame, unknown token, or a token that does not match the
   * requested role. The last two carry the same reason text so a client cannot tell them apart.
   */
  UNAUTHORIZED: 4401,
  /** Room does not exist yet (retryable). */
  NO_ROOM: 4404,
  /** Replaced by a newer connection of the same role. */
  REPLACED: 4409,
  /** Room revoked or expired (do not retry). */
  REVOKED: 4410,
  /** Too many wrong authentications; locked. */
  LOCKED: 4429,
  /** Binary frame larger than MAX_BINARY_BYTES. */
  TOO_BIG: 1009,
} as const;

export const Limits = {
  /** First frame (auth) must be at most this many characters. */
  AUTH_FRAME_MAX_CHARS: 512,
  /** Time a socket has to send its auth frame. */
  AUTH_TIMEOUT_MS: 5_000,
  /** Maximum binary frame relayed. */
  MAX_BINARY_BYTES: 2 * 1024 * 1024,
  /** Unauthenticated sockets allowed at once in one room (cheap flood guard). */
  MAX_PENDING_SOCKETS: 16,
  /** Link room: failures within the window before the lock engages. */
  LINK_FAIL_MAX: 8,
  LINK_FAIL_WINDOW_MS: 10 * 60_000,
  LINK_LOCK_MS: 15 * 60_000,
  /** Pair room: lifetime after the Host registers it. */
  PAIR_TTL_MS: 5 * 60_000,
  PAIR_FAIL_MAX: 5,
  PAIR_FAIL_WINDOW_MS: 5 * 60_000,
  PAIR_LOCK_MS: 15 * 60_000,
  /**
   * A registered room (live or revoked tombstone) with no activity for this long is wiped completely.
   * Activity = successful authentication or relayed data. Revoked tombstones use the same clock, so
   * the single-use guarantee of a pair code lasts this long (the pair TTL itself is 5 minutes).
   */
  IDLE_WIPE_MS: 30 * 24 * 60 * 60_000,
  /** `last_active` is written at most this often, so a busy room costs one SQLite write an hour. */
  ACTIVITY_WRITE_INTERVAL_MS: 60 * 60_000,
} as const;

/** Text frames the relay sends. */
export type ServerControlFrame = { t: 'ready' } | { t: 'peer'; up: boolean };

/**
 * Per-socket state kept in the WebSocket attachment so it survives hibernation (<= 16 KiB).
 * `gone` is set when the relay itself drops an authenticated socket (replaced, oversized frame,
 * room revoked...) so the later close event does not announce the peer going away a second time.
 */
export type SocketAttachment =
  | { phase: 'pending'; deadline: number; kind: RoomKind; hint: Role }
  | { phase: 'authed'; role: Role; gone?: boolean };

export const PEER_UP: ServerControlFrame = { t: 'peer', up: true };
export const PEER_DOWN: ServerControlFrame = { t: 'peer', up: false };
