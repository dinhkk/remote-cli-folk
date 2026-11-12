// The browser's side of a tab, played from Node: the tab token goes in the `Sec-WebSocket-Protocol`
// header exactly as the iframe does it, never in the URL. Used for everything that does not need a real
// browser engine (the browser-only checks are recorded in the m1 report with evidence).
import { WebSocket } from 'ws';

import { waitUntil } from './e2e-util.js';

export type RemoteMessage = Record<string, any>;

export type OpenOptions = {
  /** Replaces ['remotecli-tab', token] (for negative tests). */
  protocols?: string[];
  headers?: Record<string, string>;
};

/** One WebSocket to `/r/<peerId>/<channel>` with an inbox of parsed JSON messages. */
export class RemoteSocket {
  readonly inbox: RemoteMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Subprotocol the server selected (must be `remotecli-tab`, never the token). */
  protocol = '';
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      try {
        this.inbox.push(JSON.parse(data.toString()) as RemoteMessage);
      } catch {
        this.inbox.push({ kind: '__non-json', raw: data.toString() });
      }
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
    ws.on('error', () => undefined);
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** Connects; rejects with the HTTP status when the upgrade is refused. */
  static open(baseUrl: string, peerId: string, channel: 'ws' | 'shell', token: string | null, options: OpenOptions = {}): Promise<RemoteSocket> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/r/${peerId}/${channel}`;
    const protocols = options.protocols ?? (token ? ['remotecli-tab', token] : []);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols, { headers: options.headers });
      const socket = new RemoteSocket(ws);
      ws.once('open', () => {
        socket.protocol = ws.protocol;
        resolve(socket);
      });
      ws.once('unexpected-response', (_request, response) => reject(Object.assign(new Error(`upgrade refused: ${response.statusCode}`), { status: response.statusCode })));
      ws.once('error', (error) => reject(error));
    });
  }

  send(message: RemoteMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  /** First message after `from` that satisfies `predicate`. */
  async waitFor(predicate: (message: RemoteMessage) => boolean, what: string, timeoutMs = 15_000, from = 0): Promise<RemoteMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.inbox.slice(from).find(predicate);
      if (found) return found;
      if (this.closed) throw new Error(`socket closed (${this.closed.code} ${this.closed.reason}) while waiting for ${what}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; got kinds: ${this.inbox.slice(-12).map((m) => m.kind ?? m.type).join(',')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 250));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  waitForClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    return waitUntil(() => this.closed, 'the socket to close', timeoutMs);
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }
}
