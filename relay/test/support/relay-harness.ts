// Transport-agnostic harness for relay protocol tests (contracts.md section 4).
//
// A "harness" knows how to open a relay WebSocket and (optionally) move the relay's clock. The same
// scenario list (test/conformance/scenarios.ts) runs against every harness:
//   - in-pool workerd (this phase), via test/support/workers-harness.ts
//   - a real `wrangler dev` process over the `ws` library (this phase), test/support/node-ws-harness.ts
//   - the in-process fake relay of phases 05/06 (they only need to provide a RelayHarness)

export type RoomKind = 'link' | 'pair';
export type Role = 'host' | 'controller';

export type Incoming =
  | { type: 'text'; data: string }
  | { type: 'binary'; data: Uint8Array }
  | { type: 'close'; code: number; reason: string };

export interface ConnectParams {
  kind: RoomKind;
  room: string;
  role: Role;
  /** Hex gate. Omit to have the harness compute the valid one; pass null to send none. */
  gate?: string | null;
  /** Value of the Origin header. Omit for none (Node clients). */
  origin?: string;
  /** Raw override of the query string (for malformed-parameter tests). */
  rawQuery?: string;
}

export type ConnectResult = { status: 101; client: RelayClient } | { status: number; client?: undefined };

export interface RelayHarness {
  readonly name: string;
  connect(params: ConnectParams): Promise<ConnectResult>;
  /** Plain (non-upgrade) HTTP request against the relay. */
  http(path: string): Promise<{ status: number; body: string }>;
  gate(kind: RoomKind, room: string): Promise<string>;
  /** Origin of the relay URL (what a same-origin browser Origin header would be). */
  readonly origin: string;
  /** Present only when the relay's clock can be moved; also fires pending alarms. */
  advanceClock?(kind: RoomKind, room: string, ms: number): Promise<void>;
}

interface SocketIo {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code?: number): void;
}

const DEFAULT_WAIT_MS = 3_000;

/** Queue of messages from one socket with promise-based reads; adapters call push(). */
export class RelayClient {
  private readonly queue: Incoming[] = [];
  private waiter: ((m: Incoming) => void) | undefined;
  private closeInfo: { code: number; reason: string } | undefined;

  constructor(private readonly io: SocketIo) {}

  /** Called by the transport adapter for every inbound event. */
  push(message: Incoming): void {
    if (message.type === 'close') this.closeInfo = { code: message.code, reason: message.reason };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(message);
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

  next(timeoutMs = DEFAULT_WAIT_MS): Promise<Incoming> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Incoming>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`no message within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }

  /** Next message, which must be a JSON text frame. */
  async nextJson(timeoutMs?: number): Promise<Record<string, unknown>> {
    const m = await this.next(timeoutMs);
    if (m.type !== 'text') throw new Error(`expected text frame, got ${m.type}${m.type === 'close' ? ` ${m.code}` : ''}`);
    return JSON.parse(m.data) as Record<string, unknown>;
  }

  async nextBinary(timeoutMs?: number): Promise<Uint8Array> {
    const m = await this.next(timeoutMs);
    if (m.type !== 'binary') throw new Error(`expected binary frame, got ${m.type}${m.type === 'close' ? ` ${m.code}` : ''}`);
    return m.data;
  }

  /** Waits for the close event (skipping any frames queued before it) and returns its code. */
  async nextClose(timeoutMs = DEFAULT_WAIT_MS): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await this.next(Math.max(1, deadline - Date.now()));
      if (m.type === 'close') return m.code;
    }
  }

  /** True when nothing arrives for `ms`. */
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
