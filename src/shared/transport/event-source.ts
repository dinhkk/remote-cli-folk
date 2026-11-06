import { getStoredAuthToken } from '@/shared/authToken';
import { TargetUrlError, httpUrl, isTargetMode } from '@/shared/transport/target-context';
import { handleTargetResponse } from '@/shared/transport/target-response';

/**
 * The slice of the browser's EventSource that the application uses: named event
 * listeners, `onmessage`, `onerror` and `close`. Both the native class and the
 * fetch-based stream below satisfy it.
 */
export type EventSourceLike = {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  close: () => void;
};

// Reconnect gap: the native default (3 s), doubling after each failed attempt up to 30 s.
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;

// Answers that say "the session or the link is the problem, try again": a 401 means the
// tab token is being renewed, 502/503 mean the Controller's relay link is down. Any other
// refusal (403, 404, ...) is final, as it is for a native EventSource.
const RETRYABLE_STATUSES = new Set([401, 502, 503]);

type Attempt = 'reconnect' | 'stop';

/**
 * EventSource that authenticates with an Authorization header, which the
 * native class cannot send. A Remote tab must not put its token in a query
 * string (URLs land in proxy logs), so it streams over `fetch` instead.
 * Mirrors the native contract the callers rely on: events arrive after the
 * constructor returns, `error` fires when the stream fails or ends, the stream
 * reconnects after a pause (backing off while the server keeps failing), and
 * nothing is delivered after `close()`. Unlike the native class it also reports
 * a 401 (renew the tab token) and a relayed 502/503 (link problem overlay), and
 * it keeps reconnecting after those, since the callers' own `error` handlers
 * decide whether to give up by calling `close()`.
 */
class FetchEventSource implements EventSourceLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private readonly abort = new AbortController();
  private closed = false;
  // Consecutive failed attempts; a connection that was accepted starts the count over.
  private failedAttempts = 0;
  private wakeUp: (() => void) | null = null;

  constructor(url: string) {
    void this.run(url);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.wakeUp?.();
  }

  private emit(type: string, data: string): void {
    if (this.closed) return;
    const event = new MessageEvent(type, { data });
    if (type === 'message') this.onmessage?.(event);
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  private fail(): void {
    if (this.closed) return;
    const event = new Event('error');
    this.onerror?.(event);
    this.listeners.get('error')?.forEach((listener) => listener(event as MessageEvent));
  }

  /** Waits out the reconnect gap; resolves early when the stream is closed. */
  private pause(): Promise<void> {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, this.failedAttempts - 1), RECONNECT_MAX_MS);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async run(url: string): Promise<void> {
    // Events must arrive after the constructor returned, as with a native EventSource.
    await Promise.resolve();

    let target: string;
    try {
      target = httpUrl(url);
    } catch (error) {
      if (error instanceof TargetUrlError) {
        this.fail();
        return;
      }
      throw error;
    }

    while (!this.closed) {
      const outcome = await this.connect(target);
      if (outcome === 'stop' || this.closed) return;
      this.failedAttempts += 1;
      await this.pause();
      this.wakeUp = null;
    }
  }

  private async connect(target: string): Promise<Attempt> {
    try {
      const token = getStoredAuthToken();
      const response = await fetch(target, {
        headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        cache: 'no-store',
        signal: this.abort.signal,
      });
      if (!response.ok || !response.body) {
        if (!this.closed) handleTargetResponse(response);
        this.fail();
        return RETRYABLE_STATUSES.has(response.status) ? 'reconnect' : 'stop';
      }
      this.failedAttempts = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let eventType = '';
      let dataLines: string[] = [];

      const handleLine = (line: string) => {
        if (line === '') {
          if (dataLines.length > 0) this.emit(eventType || 'message', dataLines.join('\n'));
          eventType = '';
          dataLines = [];
          return;
        }
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') eventType = value;
        else if (field === 'data') dataLines.push(value);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        // A trailing CR may be the first half of a CRLF split across chunks.
        const holdBack = pending.endsWith('\r') ? '\r' : '';
        const lines = pending.slice(0, pending.length - holdBack.length).split(/\r\n|\r|\n/);
        pending = (lines.pop() as string) + holdBack;
        lines.forEach(handleLine);
      }
      // A stream that ends is an error followed by a reconnect, as in a native EventSource.
      this.fail();
      return 'reconnect';
    } catch {
      this.fail();
      return 'reconnect';
    }
  }
}

/**
 * Opens a server-sent-event stream: a native EventSource in Local mode, and in
 * a Remote tab a fetch-based stream aimed at `/r/<peerId>/...` that sends the
 * tab token as a bearer header. Used by the command palette and sidebar
 * conversation searches and by the project clone progress stream.
 */
export const openEventSource = (url: string): EventSourceLike =>
  isTargetMode() ? new FetchEventSource(url) : (new EventSource(url) as unknown as EventSourceLike);
