/**
 * Controller-side helpers for Host bridge tests. The mux loopback joins a Controller stream table to
 * a Host stream table; the test installs `bridge.handleStream` as the Host's incoming handler and
 * then drives requests/WebSockets from the Controller side and records what comes back.
 */

import type { RemoteMuxHeaders, RemoteMuxMeta, RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import { createMuxLoopback, type MuxLoopback, type MuxLoopbackOptions } from './mux-loopback.js';
import { waitFor } from './relay-link-rig.js';

export type HttpOutcome = {
  stream: RemoteMuxStream;
  /** Present when the Host sent HTTP_RES (an ERROR frame means it never did). */
  response?: RemoteMuxMeta['HTTP_RES'];
  body: Buffer;
  end: RemoteStreamEnd;
};

export type HttpCall = {
  stream: RemoteMuxStream;
  done: Promise<HttpOutcome>;
};

export type HttpSpec = {
  method?: string;
  path: string;
  headers?: RemoteMuxHeaders;
  /** Body chunks written after the request head; default: one empty chunk with fin (a request without body). */
  body?: Array<Buffer | string>;
  /** Set false to leave the body open (the caller finishes it with `stream.writeBody(...)`). */
  fin?: boolean;
};

/** Opens an HTTP stream from the Controller and resolves when it ends (completed, error or cancel). */
export const startHttpCall = (loop: MuxLoopback, spec: HttpSpec): HttpCall => {
  let response: HttpOutcome['response'];
  const chunks: Buffer[] = [];
  let resolveDone!: (outcome: HttpOutcome) => void;
  const done = new Promise<HttpOutcome>((resolve) => {
    resolveDone = resolve;
  });
  const stream = loop.controller.table.openStream(
    { kind: 'http', meta: { method: spec.method ?? 'GET', path: spec.path, headers: spec.headers ?? {} } },
    {
      onResponse: (meta) => {
        response = meta;
      },
      onBody: (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      // A refusal can come back before `openStream` returns, so `stream` is read one microtask later.
      onClosed: (end) => queueMicrotask(() => resolveDone({ stream, response, body: Buffer.concat(chunks), end })),
    },
  );
  const parts = spec.body ?? [];
  if (parts.length === 0) {
    if (spec.fin !== false) stream.writeBody(Buffer.alloc(0), true);
  } else {
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      stream.writeBody(Buffer.isBuffer(part) ? part : Buffer.from(part), last && spec.fin !== false);
    });
  }
  return { stream, done };
};

/** Convenience: runs one HTTP call to the end with a timeout so a hung bridge fails the test instead of the run. */
export const callThroughBridge = async (loop: MuxLoopback, spec: HttpSpec, timeoutMs = 10_000): Promise<HttpOutcome> => {
  const call = startHttpCall(loop, spec);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no outcome for ${spec.method ?? 'GET'} ${spec.path} within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([call.done, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export type WsCall = {
  stream: RemoteMuxStream;
  messages: Array<{ payload: Buffer; binary: boolean }>;
  /** Set once the stream ended. */
  end: RemoteStreamEnd | undefined;
  waitForMessages(count: number): Promise<void>;
  waitForEnd(): Promise<RemoteStreamEnd>;
};

/** Opens a WebSocket stream from the Controller and records what the Host sends back. */
export const startWsCall = (loop: MuxLoopback, path: string, protocols?: string[]): WsCall => {
  const call: WsCall = {
    stream: undefined as unknown as RemoteMuxStream,
    messages: [],
    end: undefined,
    // Host -> Controller messages wait in a 50 ms batching window on the loopback's manual clock: move it along while waiting.
    waitForMessages: (count) =>
      waitFor(() => {
        loop.clock.advance(60);
        return call.messages.length >= count;
      }, `${count} WebSocket messages`),
    waitForEnd: async () => {
      await waitFor(() => call.end !== undefined, 'the WebSocket stream to end');
      return call.end as RemoteStreamEnd;
    },
  };
  call.stream = loop.controller.table.openStream(
    { kind: 'ws', meta: protocols ? { path, protocols } : { path } },
    {
      onMessage: (payload, binary) => call.messages.push({ payload: Buffer.from(payload), binary }),
      onClosed: (end) => {
        call.end = end;
      },
    },
  );
  return call;
};

/** A Controller<->Host mux pair whose Host side hands every incoming stream to `handler`. */
export const createBridgedLoopback = (
  handler: (stream: RemoteMuxStream, open: Parameters<MuxLoopback['host']['handleIncoming']>[1]) => ReturnType<MuxLoopback['host']['handleIncoming']>,
  options: MuxLoopbackOptions = {},
): MuxLoopback => {
  const loop = createMuxLoopback(options);
  loop.host.handleIncoming = handler;
  return loop;
};

/** What a stream stub saw: lets tests drive `handleStream` with targets the mux codec would refuse to carry. */
export type StreamStub = RemoteMuxStream & {
  calls: Array<{ method: string; args: unknown[] }>;
  failure: { code: string; message: string } | undefined;
  wsClose: { code: number; reason: string } | undefined;
};

export const createStreamStub = (kind: 'http' | 'ws'): StreamStub => {
  const calls: StreamStub['calls'] = [];
  const stub = {
    id: 1,
    kind,
    closed: false,
    queuedBytes: 0,
    paused: false,
    calls,
    failure: undefined as StreamStub['failure'],
    wsClose: undefined as StreamStub['wsClose'],
    setHandlers: (...args: unknown[]) => void calls.push({ method: 'setHandlers', args }),
    sendResponse: (...args: unknown[]) => void calls.push({ method: 'sendResponse', args }),
    writeBody: (...args: unknown[]) => {
      calls.push({ method: 'writeBody', args });
      return true;
    },
    sendMessage: (...args: unknown[]) => {
      calls.push({ method: 'sendMessage', args });
      return true;
    },
    closeWebSocket: (code: number, reason: string) => {
      calls.push({ method: 'closeWebSocket', args: [code, reason] });
      stub.wsClose = { code, reason };
      stub.closed = true;
    },
    cancel: () => {
      calls.push({ method: 'cancel', args: [] });
      stub.closed = true;
    },
    fail: (code: string, message: string) => {
      calls.push({ method: 'fail', args: [code, message] });
      stub.failure = { code, message };
      stub.closed = true;
    },
  };
  return stub as unknown as StreamStub;
};
