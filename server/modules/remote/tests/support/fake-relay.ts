/**
 * In-process fake of the CloudCLI Remote relay (contracts section 4) for server tests.
 *
 * It implements the same observable protocol as the Worker in `relay/`, with no sockets: gate and
 * parameter checks, first-frame auth, hash-derived roles on `link` rooms, the single shared token
 * of `pair` rooms, replacement (4409), destroy (4410), lockout (4429), the pair-room TTL and the
 * auth deadline. A virtual clock replaces timers, so TTL and lockout tests run instantly.
 *
 * Drift between this fake and the Worker is prevented by running the relay's own conformance
 * scenarios against `asHarness()` (see `fake-relay-conformance.test.ts`).
 */

import crypto from 'node:crypto';

export type FakeRoomKind = 'link' | 'pair';
export type FakeRole = 'host' | 'controller';

export type FakeConnectParams = {
  kind: FakeRoomKind;
  room: string;
  role: FakeRole;
  /** Omit to send the valid gate; `null` sends none. */
  gate?: string | null;
  origin?: string;
  /** Raw query string override for malformed-parameter cases. */
  rawQuery?: string;
};

/** Receives what the relay sends to one client socket. Delivery is asynchronous (a microtask). */
export type FakeSocketSink = {
  text(data: string): void;
  binary(data: Uint8Array): void;
  close(code: number, reason: string): void;
};

export type FakeSocket = {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code?: number): void;
};

export type FakeOpenResult = { status: 101; socket: FakeSocket } | { status: number; socket?: undefined };

type FakeIncoming =
  | { type: 'text'; data: string }
  | { type: 'binary'; data: Uint8Array }
  | { type: 'close'; code: number; reason: string };

/** Same surface as the conformance suite's RelayClient (kept local so server builds do not import relay/ test code). */
export class FakeRelayClient {
  private readonly queue: FakeIncoming[] = [];
  private waiter: ((message: FakeIncoming) => void) | undefined;
  private closeInfo: { code: number; reason: string } | undefined;

  constructor(private readonly io: FakeSocket) {}

  push(message: FakeIncoming): void {
    if (message.type === 'close') this.closeInfo = { code: message.code, reason: message.reason };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(message);
    } else {
      this.queue.push(message);
    }
  }

  get closed(): { code: number; reason: string } | undefined {
    return this.closeInfo;
  }

  sendText(text: string): void {
    this.io.sendText(text);
  }

  sendJson(value: unknown): void {
    this.io.sendText(JSON.stringify(value));
  }

  sendBinary(bytes: Uint8Array): void {
    this.io.sendBinary(bytes);
  }

  close(code = 1000): void {
    this.io.close(code);
  }

  next(timeoutMs = 3_000): Promise<FakeIncoming> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<FakeIncoming>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`no message within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  async nextJson(timeoutMs?: number): Promise<Record<string, unknown>> {
    const message = await this.next(timeoutMs);
    if (message.type !== 'text') throw new Error(`expected text frame, got ${message.type}`);
    return JSON.parse(message.data) as Record<string, unknown>;
  }

  async nextBinary(timeoutMs?: number): Promise<Uint8Array> {
    const message = await this.next(timeoutMs);
    if (message.type !== 'binary') throw new Error(`expected binary frame, got ${message.type}`);
    return message.data;
  }

  async nextClose(timeoutMs = 3_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.next(Math.max(1, deadline - Date.now()));
      if (message.type === 'close') return message.code;
    }
  }

  async isQuietFor(ms: number): Promise<boolean> {
    if (this.queue.length > 0) return false;
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }
}

/** The connect factory the relay conformance scenarios expect (structurally a RelayHarness). */
export type FakeRelayHarness = {
  readonly name: string;
  readonly origin: string;
  connect(params: FakeConnectParams): Promise<{ status: 101; client: FakeRelayClient } | { status: number; client?: undefined }>;
  http(path: string): Promise<{ status: number; body: string }>;
  gate(kind: FakeRoomKind, room: string): Promise<string>;
  advanceClock(kind: FakeRoomKind, room: string, ms: number): Promise<void>;
};

export type FakeRelayOptions = {
  /** `RELAY_SECRET`; an empty string models a relay without a secret (503). */
  secret?: string;
  origin?: string;
  startMs?: number;
};

type Socket = {
  sink: FakeSocketSink;
  kind: FakeRoomKind;
  roomId: string;
  hintedRole: FakeRole;
  state: 'unauthenticated' | 'authenticated' | 'closed';
  authDeadline: number;
  role?: FakeRole;
};

type Room = {
  kind: FakeRoomKind;
  id: string;
  registered: boolean;
  revoked: boolean;
  hostHash?: string;
  controllerHash?: string;
  pairHash?: string;
  pairExpiresAt?: number;
  failures: number[];
  lockUntil: number;
  unauthenticated: Set<Socket>;
  active: { host?: Socket; controller?: Socket };
  pairDestroyed: { host: boolean; controller: boolean };
};

const MIN = 60_000;
const AUTH_DEADLINE_MS = 5_000;
const MAX_AUTH_FRAME_CHARS = 512;
const MAX_BINARY_BYTES = 2 * 1024 * 1024;
const MAX_UNAUTHENTICATED_SOCKETS = 16;
const LOCK_MS = 15 * MIN;
const PAIR_TTL_MS = 5 * MIN;
const LINK_FAILURE_LIMIT = { window: 10 * MIN, threshold: 8 };
const PAIR_FAILURE_LIMIT = { window: 5 * MIN, threshold: 5 };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const ROOM_PATTERN = /^[0-9a-f]{32}$/;

const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const hashesEqual = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class FakeRelay {
  readonly origin: string;
  private readonly secret: string;
  private clock: number;
  private readonly rooms = new Map<string, Room>();

  constructor({ secret = 'test-relay-secret', origin = 'https://fake-relay.test', startMs = 1_800_000_000_000 }: FakeRelayOptions = {}) {
    this.secret = secret;
    this.origin = origin;
    this.clock = startMs;
  }

  /** Virtual time in epoch milliseconds. */
  now(): number {
    return this.clock;
  }

  /** Moves the virtual clock and fires everything that became due (auth deadlines, pair TTLs). */
  advance(ms: number): void {
    this.clock += ms;
    for (const room of this.rooms.values()) {
      if (!room.revoked && room.pairExpiresAt !== undefined && room.pairExpiresAt <= this.clock) this.revoke(room);
      for (const socket of [...room.unauthenticated]) {
        if (socket.authDeadline <= this.clock) this.closeSocket(room, socket, 4401);
      }
    }
  }

  /** Valid gate for a room: lowercase hex HMAC-SHA256(secret, kind:room). */
  gate(kind: FakeRoomKind, room: string): string {
    return crypto.createHmac('sha256', this.secret).update(`${kind}:${room}`).digest('hex');
  }

  /** Resolves after every pending delivery (and the reactions they trigger) has run. */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Plain HTTP (non-upgrade) request. */
  httpStatus(path: string): { status: number; body: string } {
    const { pathname } = new URL(path, this.origin);
    if (pathname === '/healthz') return { status: 200, body: 'ok' };
    if (pathname === '/ws') return { status: 426, body: 'Expected WebSocket upgrade' };
    return { status: 404, body: 'not found' };
  }

  /** WebSocket upgrade: runs the HTTP-stage checks in contract order, then attaches a socket. */
  open(params: FakeConnectParams, sink: FakeSocketSink): FakeOpenResult {
    if (!this.secret) return { status: 503 };
    if (params.origin !== undefined && params.origin !== this.origin) return { status: 403 };

    const query = new URLSearchParams(
      params.rawQuery ?? `kind=${params.kind}&room=${params.room}&role=${params.role}`,
    );
    const kind = query.get('kind');
    const roomId = query.get('room');
    const role = query.get('role');
    if (kind !== 'link' && kind !== 'pair') return { status: 400 };
    if (role !== 'host' && role !== 'controller') return { status: 400 };
    if (!roomId || !ROOM_PATTERN.test(roomId)) return { status: 400 };

    const gate = params.rawQuery !== undefined ? query.get('gate') : params.gate === undefined ? this.gate(kind, roomId) : params.gate;
    if (!gate || !HEX64_PATTERN.test(gate) || !hashesEqual(this.gate(kind, roomId), gate)) return { status: 401 };

    const room = this.roomFor(kind, roomId);
    const socket: Socket = { sink, kind, roomId, hintedRole: role, state: 'unauthenticated', authDeadline: this.clock + AUTH_DEADLINE_MS };
    if (room.unauthenticated.size >= MAX_UNAUTHENTICATED_SOCKETS) {
      this.closeSocket(room, socket, 4429);
    } else {
      room.unauthenticated.add(socket);
    }
    return {
      status: 101,
      socket: {
        sendText: (text) => this.onClientText(room, socket, text),
        sendBinary: (bytes) => this.onClientBinary(room, socket, bytes),
        close: (code) => this.onClientClose(room, socket, code ?? 1000),
      },
    };
  }

  /** Adapter for the relay's conformance scenarios. */
  asHarness(): FakeRelayHarness {
    return {
      name: 'in-process fake relay',
      origin: this.origin,
      connect: (params) => {
        const holder: { client?: FakeRelayClient } = {};
        const result = this.open(params, {
          text: (data) => holder.client?.push({ type: 'text', data }),
          binary: (data) => holder.client?.push({ type: 'binary', data }),
          close: (code, reason) => holder.client?.push({ type: 'close', code, reason }),
        });
        if (!result.socket) return Promise.resolve({ status: result.status });
        holder.client = new FakeRelayClient(result.socket);
        return Promise.resolve({ status: 101, client: holder.client });
      },
      http: (path) => Promise.resolve(this.httpStatus(path)),
      gate: (kind, room) => Promise.resolve(this.gate(kind, room)),
      advanceClock: (_kind, _room, ms) => {
        this.advance(ms);
        return Promise.resolve();
      },
    };
  }

  // ------------------------------------------------------------------ internals

  private roomFor(kind: FakeRoomKind, id: string): Room {
    const key = `${kind}:${id}`;
    let room = this.rooms.get(key);
    if (!room) {
      room = {
        kind,
        id,
        registered: false,
        revoked: false,
        failures: [],
        lockUntil: 0,
        unauthenticated: new Set(),
        active: {},
        pairDestroyed: { host: false, controller: false },
      };
      this.rooms.set(key, room);
    }
    return room;
  }

  private deliver(action: () => void): void {
    queueMicrotask(action);
  }

  private sendJson(socket: Socket, value: unknown): void {
    const data = JSON.stringify(value);
    this.deliver(() => socket.sink.text(data));
  }

  /** Closes a socket from the relay side; the opposite role learns once, unless the close is a replacement. */
  private closeSocket(room: Room, socket: Socket, code: number, { replaced = false } = {}): void {
    if (socket.state === 'closed') return;
    const wasAuthenticated = socket.state === 'authenticated';
    socket.state = 'closed';
    room.unauthenticated.delete(socket);
    this.deliver(() => socket.sink.close(code, ''));
    if (!wasAuthenticated || !socket.role) return;
    if (room.active[socket.role] === socket) delete room.active[socket.role];
    if (!replaced) {
      const opposite = room.active[socket.role === 'host' ? 'controller' : 'host'];
      if (opposite) this.sendJson(opposite, { t: 'peer', up: false });
    }
  }

  private revoke(room: Room): void {
    room.revoked = true;
    room.pairExpiresAt = undefined;
    room.hostHash = undefined;
    room.controllerHash = undefined;
    room.pairHash = undefined;
    for (const socket of [...room.unauthenticated]) this.closeSocketQuietly(room, socket, 4410);
    for (const socket of [room.active.host, room.active.controller]) {
      if (socket) this.closeSocketQuietly(room, socket, 4410);
    }
  }

  /** Close without peer notifications (the whole room is going away). */
  private closeSocketQuietly(room: Room, socket: Socket, code: number): void {
    if (socket.state === 'closed') return;
    socket.state = 'closed';
    room.unauthenticated.delete(socket);
    if (socket.role && room.active[socket.role] === socket) delete room.active[socket.role];
    this.deliver(() => socket.sink.close(code, ''));
  }

  private onClientClose(room: Room, socket: Socket, code: number): void {
    if (socket.state === 'closed') return;
    this.closeSocket(room, socket, code);
  }

  private onClientBinary(room: Room, socket: Socket, bytes: Uint8Array): void {
    if (socket.state === 'closed') return;
    if (socket.state === 'unauthenticated') {
      this.closeSocket(room, socket, 4401);
      return;
    }
    if (bytes.length > MAX_BINARY_BYTES) {
      this.closeSocket(room, socket, 1009);
      return;
    }
    const opposite = room.active[socket.role === 'host' ? 'controller' : 'host'];
    if (!opposite) return; // nobody there: dropped, never queued
    const copy = Uint8Array.from(bytes);
    this.deliver(() => opposite.sink.binary(copy));
  }

  private onClientText(room: Room, socket: Socket, text: string): void {
    if (socket.state === 'closed') return;
    if (socket.state === 'unauthenticated') {
      this.authenticate(room, socket, text);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.closeSocket(room, socket, 4400);
      return;
    }
    const type = typeof message === 'object' && message !== null ? (message as { t?: unknown }).t : undefined;
    if (type !== 'destroy') {
      this.closeSocket(room, socket, 4400);
      return;
    }
    this.onDestroy(room, socket);
  }

  private onDestroy(room: Room, socket: Socket): void {
    const role = socket.role as FakeRole;
    if (room.kind === 'link') {
      if (role === 'host') this.revoke(room);
      else this.closeSocket(room, socket, 4400);
      return;
    }
    room.pairDestroyed[role] = true;
    if (room.pairDestroyed.host && room.pairDestroyed.controller) this.revoke(room);
  }

  private recordFailure(room: Room): void {
    const limit = room.kind === 'link' ? LINK_FAILURE_LIMIT : PAIR_FAILURE_LIMIT;
    room.failures = room.failures.filter((at) => at > this.clock - limit.window);
    room.failures.push(this.clock);
    if (room.failures.length >= limit.threshold) room.lockUntil = this.clock + LOCK_MS;
  }

  private authenticate(room: Room, socket: Socket, text: string): void {
    const reject = (code: number, { count = false } = {}): void => {
      if (count) this.recordFailure(room);
      this.closeSocket(room, socket, code);
    };

    if (text.length > MAX_AUTH_FRAME_CHARS) return reject(4401);
    let frame: { t?: unknown; token?: unknown; ctl?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return reject(4401);
    }
    if (typeof frame !== 'object' || frame === null || frame.t !== 'auth') return reject(4401);
    if (typeof frame.token !== 'string' || !TOKEN_PATTERN.test(frame.token)) return reject(4401);
    if (frame.ctl !== undefined && (typeof frame.ctl !== 'string' || !HEX64_PATTERN.test(frame.ctl))) return reject(4401);

    if (room.revoked || (room.pairExpiresAt !== undefined && room.pairExpiresAt <= this.clock)) {
      if (!room.revoked) this.revoke(room);
      return reject(4410);
    }
    if (room.lockUntil > this.clock) return reject(4429);

    const hash = sha256Hex(frame.token);
    const hinted = socket.hintedRole;
    let role: FakeRole;

    if (room.kind === 'link') {
      if (!room.registered) {
        if (hinted === 'controller') return reject(4404);
        if (frame.ctl === undefined || frame.ctl === hash) return reject(4401);
        room.hostHash = hash;
        room.controllerHash = frame.ctl as string;
        room.registered = true;
        role = 'host';
      } else {
        const inferred: FakeRole | null = hashesEqual(room.hostHash, hash) ? 'host' : hashesEqual(room.controllerHash, hash) ? 'controller' : null;
        if (!inferred) return reject(4401, { count: true });
        if (inferred !== hinted) return reject(4401);
        role = inferred;
      }
    } else if (!room.registered) {
      if (hinted === 'controller') return reject(4404);
      room.pairHash = hash;
      room.pairExpiresAt = this.clock + PAIR_TTL_MS;
      room.registered = true;
      role = 'host';
    } else {
      if (!hashesEqual(room.pairHash, hash)) return reject(4401, { count: true });
      role = hinted;
    }

    this.attach(room, socket, role);
  }

  private attach(room: Room, socket: Socket, role: FakeRole): void {
    room.unauthenticated.delete(socket);
    socket.state = 'authenticated';
    socket.role = role;
    const oppositeRole: FakeRole = role === 'host' ? 'controller' : 'host';
    const opposite = room.active[oppositeRole];
    const previous = room.active[role];
    if (previous) {
      this.closeSocket(room, previous, 4409, { replaced: true });
      if (opposite) this.sendJson(opposite, { t: 'peer', up: false });
    }
    room.active[role] = socket;
    this.sendJson(socket, { t: 'ready' });
    if (opposite) {
      this.sendJson(socket, { t: 'peer', up: true });
      this.sendJson(opposite, { t: 'peer', up: true });
    }
  }
}
