// Room Durable Object: one per `<kind>:<room>`. Forwards opaque binary frames between at most one
// Host and one Controller socket (contracts.md section 4).
//
// Design rules:
//  - WebSocket Hibernation API only; per-socket state lives in the socket attachment, room state in
//    SQLite. Nothing the protocol depends on is held in memory (the constructor re-runs after a wake-up).
//  - No timers: the auth deadline, the pair-room TTL and the 30 day idle/tombstone wipe share the
//    single alarm; the lockout is evaluated lazily from timestamps in SQLite.
//  - A room nobody registered owns no tables (created on the first Host registration) and no alarm.
//  - Only SHA-256 hashes of tokens are stored; roles are derived from which hash a token matches,
//    compared in constant time. Nothing secret is ever logged (the relay does not log at all).

import { DurableObject } from 'cloudflare:workers';
import {
  CloseCode,
  Limits,
  PEER_DOWN,
  PEER_UP,
  type Env,
  type Role,
  type RoomKind,
  type ServerControlFrame,
  type SocketAttachment,
} from './types';

const TOKEN_B64URL = /^[A-Za-z0-9_-]{16,128}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const OPEN = 1; // WebSocket.READY_STATE_OPEN
const encoder = new TextEncoder();
const ZERO_HASH = '0'.repeat(64);

interface RoomRow {
  kind: RoomKind;
  host_hash: string;
  ctl_hash: string | null;
  expires_at: number | null;
  revoked: number;
  done_host: number;
  done_controller: number;
  last_active: number;
}

// Created on the first Host registration only: a room nobody registers never owns a table.
const SCHEMA = `CREATE TABLE IF NOT EXISTS room (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kind TEXT NOT NULL,
  host_hash TEXT NOT NULL,
  ctl_hash TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  done_host INTEGER NOT NULL DEFAULT 0,
  done_controller INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS failures (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL);`;

/** Same text for "unknown token" and "token of the other role": the client must not learn which. */
const UNAUTHORIZED_REASON = 'unauthorized';

interface AuthFrame {
  token: string;
  ctl?: string;
}

const otherRole = (role: Role): Role => (role === 'host' ? 'controller' : 'host');

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/** Parses the first frame. Returns undefined for anything that is not a well-formed auth frame. */
function parseAuthFrame(message: string | ArrayBuffer): AuthFrame | undefined {
  if (typeof message !== 'string' || message.length > Limits.AUTH_FRAME_MAX_CHARS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { t, token, ctl } = value as Record<string, unknown>;
  if (t !== 'auth' || typeof token !== 'string' || !TOKEN_B64URL.test(token)) return undefined;
  if (ctl !== undefined && (typeof ctl !== 'string' || !HASH_HEX.test(ctl))) return undefined;
  return ctl === undefined ? { token } : { token, ctl };
}

function isDestroyFrame(message: string): boolean {
  if (message.length > Limits.AUTH_FRAME_MAX_CHARS) return false;
  try {
    const value = JSON.parse(message) as unknown;
    return typeof value === 'object' && value !== null && (value as { t?: unknown }).t === 'destroy';
  } catch {
    return false;
  }
}

export class Room extends DurableObject<Env> {
  /** Test hook: shifts the clock this object sees. Always 0 in production. */
  clockOffsetMs = 0;

  /** Whether the tables exist (read once per wake-up; updated by register() and wipe()). */
  private schemaReady: boolean;
  /** `last_active` as stored, so activity writes can be rate limited without reading SQLite. */
  private lastActivityWrite = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.schemaReady = ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray().length > 0;
    this.lastActivityWrite = this.loadRoom()?.last_active ?? 0;
  }

  private now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  // ------------------------------------------------------------------ upgrade

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket upgrade required', { status: 426 });

    // The Worker already validated these; the Room only needs them to interpret the first frame.
    const url = new URL(request.url);
    const kind = url.searchParams.get('kind') === 'pair' ? 'pair' : 'link';
    const hint: Role = url.searchParams.get('role') === 'controller' ? 'controller' : 'host';

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    const crowded = this.openSockets().filter((s) => this.attachmentOf(s)?.phase === 'pending').length >= Limits.MAX_PENDING_SOCKETS;
    this.ctx.acceptWebSocket(server);
    if (crowded) {
      server.close(CloseCode.LOCKED, 'too many unauthenticated sockets');
    } else {
      const attachment: SocketAttachment = { phase: 'pending', deadline: this.now() + Limits.AUTH_TIMEOUT_MS, kind, hint };
      server.serializeAttachment(attachment);
      await this.rescheduleAlarm();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ socket events

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachmentOf(ws);
    if (!attachment) return void ws.close(CloseCode.UNAUTHORIZED, 'unauthenticated');
    if (attachment.phase === 'pending') return this.handleFirstFrame(ws, attachment, message);
    if (attachment.gone) return; // already dropped by the relay; ignore stragglers

    if (typeof message === 'string') return this.handleControlText(ws, attachment.role, message);
    if (message.byteLength > Limits.MAX_BINARY_BYTES) return this.dropAuthed(ws, attachment.role, CloseCode.TOO_BIG, 'frame too large');
    this.recordActivity(this.now());
    this.sendTo(this.peerSocket(attachment.role), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.retire(ws);
    try {
      // Complete the closing handshake. 1005/1006/1015 are reserved and cannot be sent.
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    await this.rescheduleAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.retire(ws);
    try {
      ws.close(1011, 'error');
    } catch {
      // already closed
    }
    await this.rescheduleAlarm();
  }

  /**
   * The single alarm: auth deadlines of pending sockets, the pair-room TTL, and the 30 day wipe of an
   * idle room or a revoked tombstone.
   */
  async alarm(): Promise<void> {
    const now = this.now();
    for (const ws of this.openSockets()) {
      const a = this.attachmentOf(ws);
      if (a?.phase === 'pending' && a.deadline <= now) this.safeClose(ws, CloseCode.UNAUTHORIZED, 'auth timeout');
    }
    const row = this.loadRoom();
    if (row && !row.revoked && row.expires_at !== null && row.expires_at <= now) {
      this.destroyRoom(now);
    } else if (row && row.last_active + Limits.IDLE_WIPE_MS <= now) {
      // Somebody being connected is activity: only a room nobody is attached to goes away.
      if (this.openSockets().some((ws) => this.attachmentOf(ws)?.phase === 'authed')) this.recordActivity(now, true);
      else await this.wipe();
    }
    await this.rescheduleAlarm();
  }

  // ------------------------------------------------------------------ authentication

  private async handleFirstFrame(ws: WebSocket, attachment: SocketAttachment & { phase: 'pending' }, message: string | ArrayBuffer): Promise<void> {
    await this.authenticate(ws, attachment, message);
    // Whatever the outcome (closed socket, new registration, expiry), the alarm must match the state.
    await this.rescheduleAlarm();
  }

  private async authenticate(ws: WebSocket, attachment: SocketAttachment & { phase: 'pending' }, message: string | ArrayBuffer): Promise<void> {
    const frame = parseAuthFrame(message);
    if (!frame) return this.rejectPending(ws, CloseCode.UNAUTHORIZED, 'invalid first frame');

    // All awaits happen before the synchronous state transition below.
    const tokenHash = await sha256Hex(frame.token);
    if (ws.readyState !== OPEN) return;

    // A second frame may have been dispatched while this one was hashing. If the first one already
    // authenticated the socket, this is a text frame from an authenticated client: same verdict as
    // handleControlText gives. If it closed the socket, there is nothing left to do.
    const current = this.attachmentOf(ws);
    if (current?.phase !== 'pending') {
      if (current && !current.gone) this.dropAuthed(ws, current.role, CloseCode.BAD_FRAME, 'unexpected text frame');
      return;
    }

    const now = this.now();
    const row = this.loadRoom();
    if (row?.revoked) return this.rejectPending(ws, CloseCode.REVOKED, 'revoked');
    if (row && row.expires_at !== null && row.expires_at <= now) return this.destroyRoom(now); // pair TTL, even if the alarm is late
    if (this.isLocked(now)) return this.rejectPending(ws, CloseCode.LOCKED, 'locked');

    let role: Role;
    if (!row) {
      if (attachment.hint !== 'host') return this.rejectPending(ws, CloseCode.NO_ROOM, 'no such room');
      if (attachment.kind === 'link' && (frame.ctl === undefined || sameHash(frame.ctl, tokenHash))) {
        return this.rejectPending(ws, CloseCode.UNAUTHORIZED, 'host registration needs ctl');
      }
      this.register(attachment.kind, tokenHash, attachment.kind === 'link' ? frame.ctl! : null, now);
      role = 'host';
    } else {
      // Both comparisons always run (no early exit) so timing does not reveal which hash matched.
      const hostMatch = sameHash(tokenHash, row.host_hash);
      const ctlMatch = sameHash(tokenHash, row.ctl_hash ?? ZERO_HASH) && row.ctl_hash !== null;
      const derived: Role | undefined = attachment.kind === 'link' ? (hostMatch ? 'host' : ctlMatch ? 'controller' : undefined) : hostMatch ? attachment.hint : undefined;
      if (!derived) {
        this.recordFailure(attachment.kind, now);
        return this.rejectPending(ws, CloseCode.UNAUTHORIZED, UNAUTHORIZED_REASON);
      }
      // Not counted as a failure (the token was valid), but indistinguishable from a bad token to the client.
      if (derived !== attachment.hint) return this.rejectPending(ws, CloseCode.UNAUTHORIZED, UNAUTHORIZED_REASON);
      role = derived;
      this.recordActivity(now);
    }

    this.activate(ws, role);
  }

  private register(kind: RoomKind, hostHash: string, ctlHash: string | null, now: number): void {
    const expiresAt = kind === 'pair' ? now + Limits.PAIR_TTL_MS : null;
    if (!this.schemaReady) {
      this.ctx.storage.sql.exec(SCHEMA);
      this.schemaReady = true;
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO room (id, kind, host_hash, ctl_hash, created_at, last_active, expires_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
      kind,
      hostHash,
      ctlHash,
      now,
      now,
      expiresAt,
    );
    this.lastActivityWrite = now;
  }

  /**
   * Notes that the room is in use. `last_active` is written at most once per
   * ACTIVITY_WRITE_INTERVAL_MS (or when `force` is set) so a busy room is not a write per frame.
   */
  private recordActivity(now: number, force = false): void {
    if (!this.schemaReady || (!force && now - this.lastActivityWrite < Limits.ACTIVITY_WRITE_INTERVAL_MS)) return;
    this.ctx.storage.sql.exec('UPDATE room SET last_active = ? WHERE id = 1 AND revoked = 0', now);
    this.lastActivityWrite = now;
  }

  /** Removes everything this room stores, alarm included. The next registration starts from scratch. */
  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.schemaReady = false;
    this.lastActivityWrite = 0;
  }

  /** Makes `ws` the live socket of `role`: replaces the previous one and announces presence. */
  private activate(ws: WebSocket, role: Role): void {
    const previous = this.liveSocket(role);
    if (previous) this.dropAuthed(previous, role, CloseCode.REPLACED, 'replaced', false);

    const attachment: SocketAttachment = { phase: 'authed', role };
    ws.serializeAttachment(attachment);
    this.sendTo(ws, { t: 'ready' });

    const peer = this.liveSocket(otherRole(role));
    if (peer) {
      if (previous) this.sendTo(peer, PEER_DOWN); // the old connection is gone, then the new one is up
      this.sendTo(peer, PEER_UP);
      this.sendTo(ws, PEER_UP);
    }
  }

  // ------------------------------------------------------------------ control frames and destroy

  private handleControlText(ws: WebSocket, role: Role, text: string): void {
    if (!isDestroyFrame(text)) return this.dropAuthed(ws, role, CloseCode.BAD_FRAME, 'unexpected text frame');

    const row = this.loadRoom();
    if (!row || row.revoked) return;
    if (row.kind === 'link') {
      if (role !== 'host') return this.dropAuthed(ws, role, CloseCode.BAD_FRAME, 'destroy needs the host token');
      return this.destroyRoom(this.now());
    }
    // Pair room: each side reports completion; the room ends when both have.
    const column = role === 'host' ? 'done_host' : 'done_controller';
    this.ctx.storage.sql.exec(`UPDATE room SET ${column} = 1 WHERE id = 1`);
    const after = this.loadRoom();
    if (after && after.done_host && after.done_controller) this.destroyRoom(this.now());
  }

  /**
   * Revokes the room: writes the tombstone (no hashes) FIRST, then closes every socket with 4410, so a
   * failed write can never leave sockets closed on a room that is still usable. The tombstone itself is
   * wiped IDLE_WIPE_MS later by the alarm.
   */
  private destroyRoom(now: number): void {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("UPDATE room SET host_hash = '', ctl_hash = NULL, revoked = 1, expires_at = NULL, last_active = ? WHERE id = 1", now);
      sql.exec('DELETE FROM failures');
      sql.exec('DELETE FROM lock');
    });
    this.lastActivityWrite = now;
    for (const ws of this.openSockets()) {
      const a = this.attachmentOf(ws);
      if (a?.phase === 'authed') ws.serializeAttachment({ ...a, gone: true } satisfies SocketAttachment);
      this.safeClose(ws, CloseCode.REVOKED, 'revoked');
    }
  }

  // ------------------------------------------------------------------ lockout (lazy, in SQLite)

  private isLocked(now: number): boolean {
    if (!this.schemaReady) return false;
    const rows = this.ctx.storage.sql.exec('SELECT until FROM lock WHERE id = 1').toArray() as { until: number }[];
    return rows.length > 0 && rows[0]!.until > now;
  }

  private recordFailure(kind: RoomKind, now: number): void {
    const [max, windowMs, lockMs] =
      kind === 'pair'
        ? [Limits.PAIR_FAIL_MAX, Limits.PAIR_FAIL_WINDOW_MS, Limits.PAIR_LOCK_MS]
        : [Limits.LINK_FAIL_MAX, Limits.LINK_FAIL_WINDOW_MS, Limits.LINK_LOCK_MS];
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM failures WHERE at <= ?', now - windowMs);
      sql.exec('INSERT INTO failures (at) VALUES (?)', now);
      const { n } = sql.exec('SELECT COUNT(*) AS n FROM failures').one() as { n: number };
      if (n >= max) {
        sql.exec('INSERT OR REPLACE INTO lock (id, until) VALUES (1, ?)', now + lockMs);
        sql.exec('DELETE FROM failures');
      }
    });
  }

  // ------------------------------------------------------------------ helpers

  private loadRoom(): RoomRow | undefined {
    if (!this.schemaReady) return undefined;
    const rows = this.ctx.storage.sql
      .exec('SELECT kind, host_hash, ctl_hash, expires_at, revoked, done_host, done_controller, last_active FROM room WHERE id = 1')
      .toArray();
    return rows[0] as unknown as RoomRow | undefined;
  }

  /** `ws.close` throws on a socket that is already closing; that is not an error for the caller. */
  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private attachmentOf(ws: WebSocket): SocketAttachment | undefined {
    return (ws.deserializeAttachment() as SocketAttachment | null) ?? undefined;
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN);
  }

  /** The authenticated, not-yet-dropped socket of `role`, if any. */
  private liveSocket(role: Role): WebSocket | undefined {
    return this.openSockets().find((ws) => {
      const a = this.attachmentOf(ws);
      return a?.phase === 'authed' && a.role === role && !a.gone;
    });
  }

  private peerSocket(role: Role): WebSocket | undefined {
    return this.liveSocket(otherRole(role));
  }

  private sendTo(ws: WebSocket | undefined, payload: ServerControlFrame | ArrayBuffer): void {
    if (!ws) return;
    try {
      ws.send(payload instanceof ArrayBuffer ? payload : JSON.stringify(payload));
    } catch {
      // socket closing; its close event cleans up
    }
  }

  /** Closes a socket that has not authenticated. No peer is told: it never was a peer. */
  private rejectPending(ws: WebSocket, code: number, reason: string): void {
    this.safeClose(ws, code, reason);
  }

  /**
   * Closes an authenticated socket on the relay's initiative. Marks it gone first so its close
   * event stays silent, and tells the other side it went away (unless a replacement follows).
   */
  private dropAuthed(ws: WebSocket, role: Role, code: number, reason: string, announce = true): void {
    ws.serializeAttachment({ phase: 'authed', role, gone: true } satisfies SocketAttachment);
    this.safeClose(ws, code, reason);
    if (announce) this.sendTo(this.liveSocket(otherRole(role)), PEER_DOWN);
  }

  /** Close/error from the client side: announce the peer going away if the relay had not already. */
  private retire(ws: WebSocket): void {
    const a = this.attachmentOf(ws);
    if (a?.phase !== 'authed' || a.gone) return;
    ws.serializeAttachment({ ...a, gone: true } satisfies SocketAttachment);
    this.sendTo(this.liveSocket(otherRole(a.role)), PEER_DOWN);
  }

  /**
   * Points the single alarm at the earliest of: an auth deadline, the pair TTL, the idle/tombstone
   * wipe. A room with no row and nobody waiting has nothing to schedule: the alarm is removed (only
   * when one exists, to avoid a pointless write).
   */
  private async rescheduleAlarm(): Promise<void> {
    const deadlines: number[] = [];
    for (const ws of this.openSockets()) {
      const a = this.attachmentOf(ws);
      if (a?.phase === 'pending') deadlines.push(a.deadline);
    }
    const row = this.loadRoom();
    if (row) {
      if (!row.revoked && row.expires_at !== null) deadlines.push(row.expires_at);
      deadlines.push(row.last_active + Limits.IDLE_WIPE_MS);
    }
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
  }
}
