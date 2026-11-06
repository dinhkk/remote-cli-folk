/**
 * A scriptable stand-in for a `RemoteRelayLink` and its mux streams, for tests of the code that USES a
 * link (peer registry, Controller proxy, WebSocket gateway, Host accept). The real link is covered by
 * the phase that owns it; here the test decides the status, when the session is up and what the Host
 * "answers" on each stream.
 */

import type {
  RemoteErrorCode,
  RemoteLinkEvents,
  RemoteLinkStatus,
  RemoteMuxMeta,
  RemoteMuxStream,
  RemotePairingRole,
  RemoteRelayLink,
  RemoteStreamEnd,
  RemoteStreamHandlers,
  RemoteStreamOpen,
} from '@/shared/types.js';

import { RemoteLinkDownError } from '../../link/relay-link.js';

/** A stream whose handlers the test drives and whose outgoing calls it records. */
export type FakeStream = RemoteMuxStream & {
  open: RemoteStreamOpen;
  handlers: RemoteStreamHandlers;
  /** Chunks the code under test wrote (request body) in order, with the fin flag. */
  written: Array<{ chunk: Buffer; fin: boolean }>;
  /** Messages the code under test sent (WebSocket). */
  sent: Array<{ payload: Buffer; binary: boolean }>;
  calls: string[];
  failure: { code: RemoteErrorCode; message: string } | null;
  closeInfo: { code: number; reason: string } | null;
  /** Simulates the peer sending the response head. */
  respond(meta: RemoteMuxMeta['HTTP_RES']): void;
  /** Simulates a response body chunk (or the WS message when `ws`). */
  body(chunk: Buffer | string, fin?: boolean): void;
  message(payload: Buffer | string, binary?: boolean): void;
  /** Simulates the stream ending for a reason (peer ERROR, peer WS_CLOSE, link down ...). */
  end(end: RemoteStreamEnd): void;
  /** Makes the next write return false (queue above the high-water mark). */
  pauseWrites(): void;
  resumeWrites(): void;
};

export type FakeLink = RemoteRelayLink & {
  streams: FakeStream[];
  started: boolean;
  closed: boolean;
  setStatus(status: Partial<RemoteLinkStatus>): void;
  setSession(active: boolean): void;
  emit<E extends keyof RemoteLinkEvents>(event: E, payload: RemoteLinkEvents[E]): void;
  /** Called for every `openStream`; throw to refuse (e.g. `RemoteLinkDownError`). */
  onOpen: ((open: RemoteStreamOpen) => void) | null;
  /** New streams pause their writer (like a full mux queue) once this many bytes were written. */
  autoPauseAfterBytes: number | null;
  /** Handler installed through `onStream` (Host side). */
  incomingHandler: ((stream: RemoteMuxStream, open: RemoteStreamOpen) => RemoteErrorCode | void) | null;
};

const asBuffer = (value: Buffer | string): Buffer => (typeof value === 'string' ? Buffer.from(value) : value);

export const createFakeStream = (
  id: number,
  open: RemoteStreamOpen,
  handlers: RemoteStreamHandlers,
  autoPauseAfterBytes: number | null = null,
): FakeStream => {
  let closed = false;
  let paused = false;
  let totalWritten = 0;
  let autoPauseUsed = false;
  const stream: FakeStream = {
    id,
    kind: open.kind,
    open,
    handlers,
    written: [],
    sent: [],
    calls: [],
    failure: null,
    closeInfo: null,
    get closed() {
      return closed;
    },
    get queuedBytes() {
      return 0;
    },
    get paused() {
      return paused;
    },
    setHandlers(next) {
      stream.handlers = next;
    },
    sendResponse() {
      stream.calls.push('sendResponse');
    },
    writeBody(chunk, fin = false) {
      stream.calls.push('writeBody');
      stream.written.push({ chunk: Buffer.from(chunk), fin });
      totalWritten += chunk.length;
      if (autoPauseAfterBytes !== null && totalWritten >= autoPauseAfterBytes && !autoPauseUsed) {
        autoPauseUsed = true;
        paused = true;
        stream.handlers.onPause?.();
      }
      return !paused;
    },
    sendMessage(payload, binary) {
      stream.calls.push('sendMessage');
      stream.sent.push({ payload: Buffer.from(payload), binary });
      return !paused;
    },
    closeWebSocket(code, reason) {
      stream.calls.push('closeWebSocket');
      stream.closeInfo = { code, reason };
      finish({ cause: 'local-ws-close', code, reason });
    },
    cancel() {
      stream.calls.push('cancel');
      finish({ cause: 'local-cancel' });
    },
    fail(code, message) {
      stream.calls.push('fail');
      stream.failure = { code, message };
      finish({ cause: 'error', origin: 'local', code, message });
    },
    respond(meta) {
      stream.handlers.onResponse?.(meta);
    },
    body(chunk, fin = false) {
      stream.handlers.onBody?.(asBuffer(chunk), fin);
    },
    message(payload, binary = false) {
      stream.handlers.onMessage?.(asBuffer(payload), binary);
    },
    end(reason) {
      finish(reason);
    },
    pauseWrites() {
      paused = true;
      stream.handlers.onPause?.();
    },
    resumeWrites() {
      paused = false;
      stream.handlers.onResume?.();
    },
  };
  function finish(reason: RemoteStreamEnd): void {
    if (closed) return;
    closed = true;
    stream.handlers.onClosed?.(reason);
  }
  return stream;
};

export const createFakeLink = (role: RemotePairingRole = 'controller'): FakeLink => {
  let status: RemoteLinkStatus = { state: 'connecting', peerState: 'connecting', reason: null, attempt: 0, retryInMs: null };
  let sessionActive = false;
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let nextStreamId = 1;

  const link: FakeLink = {
    role,
    streams: [],
    started: false,
    closed: false,
    onOpen: null,
    autoPauseAfterBytes: null,
    incomingHandler: null,
    get status() {
      return status;
    },
    get sessionActive() {
      return sessionActive;
    },
    get peerAppVersion() {
      return sessionActive ? 'peer-1.0' : null;
    },
    start() {
      link.started = true;
    },
    close() {
      link.closed = true;
      status = { state: 'stopped', peerState: 'offline', reason: 'stopped', attempt: 0, retryInMs: null };
      sessionActive = false;
    },
    openStream(open, handlers) {
      if (!sessionActive) {
        throw new RemoteLinkDownError();
      }
      link.onOpen?.(open);
      const stream = createFakeStream(nextStreamId, open, handlers, link.autoPauseAfterBytes);
      nextStreamId += 2;
      link.streams.push(stream);
      return stream;
    },
    onStream(handler) {
      link.incomingHandler = handler;
      return () => {
        if (link.incomingHandler === handler) link.incomingHandler = null;
      };
    },
    destroyRoom() {
      return false;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (payload: never) => void);
    },
    setStatus(next) {
      status = { ...status, ...next };
      for (const listener of listeners.get('state') ?? []) (listener as (payload: RemoteLinkStatus) => void)(status);
    },
    setSession(active) {
      sessionActive = active;
      const payload: RemoteLinkEvents['session'] = active ? { up: true, peerAppVersion: 'peer-1.0' } : { up: false, reason: 'peer-down' };
      for (const listener of listeners.get('session') ?? []) (listener as (event: RemoteLinkEvents['session']) => void)(payload);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) (listener as (event: unknown) => void)(payload);
    },
  };
  return link;
};

/** A link that is online with an established session, the common starting point. */
export const createOnlineFakeLink = (role: RemotePairingRole = 'controller'): FakeLink => {
  const link = createFakeLink(role);
  link.setStatus({ state: 'online', peerState: 'online', reason: null });
  link.setSession(true);
  return link;
};
