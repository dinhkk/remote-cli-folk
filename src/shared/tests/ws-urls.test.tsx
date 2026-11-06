import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * The two WebSockets, the three EventSources and the XHR uploader are the
 * transports that cannot go through authenticatedFetch. In a Remote tab each of
 * them must aim at /r/<peerId>/..., authenticate without a query token (the
 * tab token rides as a WebSocket subprotocol or an Authorization header), and
 * keep Local mode exactly as it was.
 */

const PEER = 'peer_abc12345';

const makeToken = (label: string, ttlSeconds = 600) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now - 5, exp: now + ttlSeconds, label })}.sig`;
};

const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { user, current: { user, token: 'placeholder', isLoading: false } };
});
vi.mock('@/modules/auth', () => ({ useAuth: () => AUTH.current }));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  constructor(readonly url: string, readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const enterTargetMode = async (token: string | null = makeToken('first')) => {
  vi.resetModules();
  window.history.replaceState(null, '', `/?target=${PEER}`);
  window.name = '';
  const ctx = await import('@/shared/transport/target-context');
  ctx.initTargetContext();
  ctx.setTabToken(token);
  return ctx;
};

const enterLocalMode = () => {
  vi.resetModules();
  window.history.replaceState(null, '', '/');
  window.name = '';
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  AUTH.current = { user: AUTH.user, token: 'placeholder', isLoading: false };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.name = '';
  window.history.replaceState(null, '', '/');
});

// ---------------------------------------------------------------------------
// Chat WebSocket
// ---------------------------------------------------------------------------

test('the chat socket in a tab connects through /r/<peerId>/ws with the token as a subprotocol', async () => {
  const token = makeToken('first');
  await enterTargetMode(token);
  const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');

  render(<WebSocketProvider><span /></WebSocketProvider>);

  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0] as FakeWebSocket;
  assert.equal(socket.url, `ws://localhost:3000/r/${PEER}/ws`);
  assert.deepEqual(socket.protocols, ['cloudcli-tab', token]);
  assert.equal(socket.url.includes('token='), false);
});

test('a new tab token does not reconnect the chat socket: the token lives in a ref', async () => {
  const ctx = await enterTargetMode(makeToken('first'));
  const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');
  const view = render(<WebSocketProvider><span /></WebSocketProvider>);
  assert.equal(FakeWebSocket.instances.length, 1);

  act(() => ctx.setTabToken(makeToken('second')));
  view.rerender(<WebSocketProvider><span /></WebSocketProvider>);

  assert.equal(FakeWebSocket.instances.length, 1, 'the existing socket must be kept');
  assert.equal((FakeWebSocket.instances[0] as FakeWebSocket).readyState, FakeWebSocket.CONNECTING);
});

test('a reconnect after the token was refreshed offers the new token', async () => {
  vi.useFakeTimers();
  const ctx = await enterTargetMode(makeToken('first'));
  const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');
  render(<WebSocketProvider><span /></WebSocketProvider>);
  const second = makeToken('second');
  act(() => ctx.setTabToken(second));

  act(() => (FakeWebSocket.instances[0] as FakeWebSocket).close());
  act(() => {
    vi.advanceTimersByTime(3000);
  });

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.deepEqual((FakeWebSocket.instances[1] as FakeWebSocket).protocols, ['cloudcli-tab', second]);
});

test('without a usable token the chat socket waits and retries instead of giving up', async () => {
  vi.useFakeTimers();
  const ctx = await enterTargetMode(null);
  const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');
  render(<WebSocketProvider><span /></WebSocketProvider>);
  assert.equal(FakeWebSocket.instances.length, 0);

  act(() => ctx.setTabToken(makeToken('late')));
  act(() => {
    vi.advanceTimersByTime(3000);
  });

  assert.equal(FakeWebSocket.instances.length, 1);
});

test('local mode keeps the token in the query and offers no subprotocol', async () => {
  enterLocalMode();
  AUTH.current = { user: AUTH.user, token: 'local-token', isLoading: false };
  const token = makeToken('local');
  localStorage.setItem('auth-token', token);
  const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');

  render(<WebSocketProvider><span /></WebSocketProvider>);

  const socket = FakeWebSocket.instances[0] as FakeWebSocket;
  assert.equal(socket.url, `ws://localhost:3000/ws?token=${encodeURIComponent('local-token')}`);
  assert.equal(socket.protocols, undefined);
});

// ---------------------------------------------------------------------------
// Shell WebSocket
// ---------------------------------------------------------------------------

test('the shell socket goes through /r/<peerId>/shell with the subprotocol', async () => {
  const token = makeToken('shell');
  await enterTargetMode(token);
  const socketUtils = await import('@/modules/shell/utils/socket');

  assert.equal(socketUtils.getShellWebSocketUrl(), `ws://localhost:3000/r/${PEER}/shell`);
  assert.deepEqual(socketUtils.getShellWebSocketProtocols(), ['cloudcli-tab', token]);
});

test('the shell socket is not opened without a token in a tab', async () => {
  await enterTargetMode(null);
  const socketUtils = await import('@/modules/shell/utils/socket');

  assert.equal(socketUtils.getShellWebSocketUrl(), null);
});

test('the local shell socket is unchanged', async () => {
  enterLocalMode();
  const token = makeToken('local');
  localStorage.setItem('auth-token', token);
  const socketUtils = await import('@/modules/shell/utils/socket');

  assert.equal(
    socketUtils.getShellWebSocketUrl(),
    `ws://localhost:3000/shell?token=${encodeURIComponent(token)}`,
  );
  assert.equal(socketUtils.getShellWebSocketProtocols(), undefined);
});

test('useShellConnection hands the protocols to the browser WebSocket', () => {
  const source = readFileSync('src/modules/shell/hooks/useShellConnection.ts', 'utf8');

  assert.match(source, /new WebSocket\(wsUrl, getShellWebSocketProtocols\(\)\)/);
});

// ---------------------------------------------------------------------------
// EventSource (three call sites)
// ---------------------------------------------------------------------------

const sseResponse = (chunks: string[], status = 200) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
};

test('local mode opens a real EventSource on the URL it was given', async () => {
  enterLocalMode();
  const opened: string[] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener() {}
      close() {}
    },
  );
  const { openEventSource } = await import('@/shared/transport/event-source');

  openEventSource('/api/providers/search/sessions?q=a&token=t');

  assert.deepEqual(opened, ['/api/providers/search/sessions?q=a&token=t']);
});

test('a tab streams SSE over fetch with the bearer header and no EventSource', async () => {
  const token = makeToken('sse');
  await enterTargetMode(token);
  const constructed: string[] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(url: string) {
        constructed.push(url);
      }
    },
  );
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    sseResponse([
      'event: result\ndata: {"n":1}\n\n',
      'event: do',
      'ne\ndata: {}\n\n',
      ': keep-alive\n\ndata: {"plain":true}\n\n',
    ]),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { openEventSource } = await import('@/shared/transport/event-source');

  const stream = openEventSource('/api/providers/search/sessions?q=a');
  const seen: Array<[string, string]> = [];
  stream.addEventListener('result', (event) => seen.push(['result', event.data]));
  stream.addEventListener('done', (event) => seen.push(['done', event.data]));
  stream.onmessage = (event) => seen.push(['message', event.data]);

  await vi.waitFor(() => assert.equal(seen.length, 3));
  assert.deepEqual(seen, [
    ['result', '{"n":1}'],
    ['done', '{}'],
    ['message', '{"plain":true}'],
  ]);
  assert.deepEqual(constructed, []);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  assert.equal(url, `/r/${PEER}/api/providers/search/sessions?q=a`);
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
  assert.equal(init.cache, 'no-store');
});

test('a tab stream reports an error event when the server refuses it, and close() stops delivery', async () => {
  await enterTargetMode();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 503 })));
  const { openEventSource } = await import('@/shared/transport/event-source');

  const refused = openEventSource('/api/x');
  let errors = 0;
  refused.onerror = () => {
    errors += 1;
  };
  await vi.waitFor(() => assert.equal(errors, 1));
  refused.close();

  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['data: late\n\n'])));
  const closed = openEventSource('/api/y');
  const delivered: string[] = [];
  closed.onmessage = (event) => delivered.push(event.data);
  closed.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(delivered, []);
});

/** Opens a tab stream on fake timers (setTimeout only) and counts connection attempts. */
const openCountedStream = async (replies: Array<() => Response | Promise<Response>>) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = replies[Math.min(fetchMock.mock.calls.length - 1, replies.length - 1)] as () => Response | Promise<Response>;
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  const { openEventSource } = await import('@/shared/transport/event-source');
  const stream = openEventSource('/api/providers/search/sessions?q=a');
  const events: string[] = [];
  stream.onerror = () => events.push('error');
  stream.onmessage = (event) => events.push(`message:${event.data}`);
  return { stream, events, fetchMock };
};
const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

test('a tab stream that gets 503 reports the link problem, errors, and reconnects with backoff', async () => {
  const ctx = await enterTargetMode();
  const linkEvents: unknown[] = [];
  ctx.onLinkEvent((event) => linkEvents.push(event));
  const { stream, events, fetchMock } = await openCountedStream([
    () => new Response(JSON.stringify({ error: { code: 'REMOTE_LINK_DOWN' } }), { status: 503 }),
    () => new Response('{}', { status: 502 }),
    () => sseResponse(['data: back\n\n']),
  ]);

  await flush();
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.deepEqual(events, ['error']);
  assert.deepEqual(linkEvents, [{ kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 }]);

  await flush(500); // the first gap is longer than this
  assert.equal(fetchMock.mock.calls.length, 1);
  await flush(3000);
  assert.equal(fetchMock.mock.calls.length, 2);
  await flush(1000); // the second gap doubled
  assert.equal(fetchMock.mock.calls.length, 2);
  await flush(6000);
  assert.equal(fetchMock.mock.calls.length, 3);
  assert.ok(events.includes('message:back'), 'the stream delivers again once the server answers');
  stream.close();
});

test('a tab stream that gets 401 asks the page for a new token and reconnects', async () => {
  const ctx = await enterTargetMode();
  let tokenRequests = 0;
  ctx.onTokenExpired(() => {
    tokenRequests += 1;
  });
  const { stream, events, fetchMock } = await openCountedStream([
    () => new Response('{}', { status: 401 }),
    () => sseResponse(['data: ok\n\n']),
  ]);

  await flush();
  assert.equal(tokenRequests, 1);
  assert.deepEqual(events, ['error']);
  await flush(3500);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.ok(events.includes('message:ok'));
  stream.close();
});

test('a refusal that retrying cannot fix (403, 404) errors once and does not reconnect, like a native EventSource', async () => {
  await enterTargetMode();
  for (const status of [403, 404]) {
    const { stream, events, fetchMock } = await openCountedStream([() => new Response('{}', { status })]);
    await flush(60_000);
    assert.equal(fetchMock.mock.calls.length, 1, `status ${status}`);
    assert.deepEqual(events, ['error']);
    stream.close();
    vi.useRealTimers();
  }
});

test('a stream that ends reconnects after a pause, as a native EventSource does', async () => {
  await enterTargetMode();
  const { stream, events, fetchMock } = await openCountedStream([() => sseResponse(['data: one\n\n']), () => sseResponse(['data: two\n\n'])]);

  await flush();
  assert.deepEqual(events, ['message:one', 'error']);
  await flush(3500);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.ok(events.includes('message:two'));
  stream.close();
});

test('close() during the pause cancels the reconnect', async () => {
  await enterTargetMode();
  const { stream, fetchMock } = await openCountedStream([() => new Response('{}', { status: 503 })]);

  await flush();
  stream.close();
  await flush(120_000);

  assert.equal(fetchMock.mock.calls.length, 1);
});

test('a hostile stream URL errors without any request', async () => {
  await enterTargetMode();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetchMock = vi.fn(async () => sseResponse([]));
  vi.stubGlobal('fetch', fetchMock);
  const { openEventSource } = await import('@/shared/transport/event-source');

  const stream = openEventSource('//evil.example/api/x');
  let errors = 0;
  stream.onerror = () => {
    errors += 1;
  };
  await flush(60_000);

  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(errors, 1);
});

test('all three EventSource call sites go through openEventSource', () => {
  for (const file of [
    'src/modules/command-palette/hooks/useSessionMessageSearch.ts',
    'src/modules/project-creation-wizard/utils/workspaceApi.ts',
    'src/modules/sidebar/hooks/useSidebarController.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/new EventSource\(/.test(source), false, `${file} still opens a raw EventSource`);
    assert.match(source, /openEventSource\(/, `${file} does not use openEventSource`);
  }
});

// ---------------------------------------------------------------------------
// XHR upload
// ---------------------------------------------------------------------------

class FakeXhr {
  static instances: FakeXhr[] = [];
  upload: { onprogress: ((event: unknown) => void) | null } = { onprogress: null };
  headers: Record<string, string> = {};
  method = '';
  url = '';
  status = 200;
  responseText = '{"uploadedCount":1,"requestedFileCount":1}';
  responseHeaders: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name] ?? null;
  }
  send() {}
}

const runUpload = async (responseHeaders: Record<string, string> = {}) => {
  FakeXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  const { useFileTreeUpload } = await import('@/modules/file-tree/hooks/useFileTreeUpload');
  const { result } = renderHook(() =>
    useFileTreeUpload({
      selectedProject: { projectId: 'p1' } as Project,
      onRefresh: () => undefined,
      showToast: () => undefined,
    }),
  );
  let pending: Promise<void> | undefined;
  act(() => {
    pending = result.current.uploadFiles([new File(['x'], 'a.txt')], '');
  });
  await vi.waitFor(() => assert.equal(FakeXhr.instances.length, 1));
  const xhr = FakeXhr.instances[0] as FakeXhr;
  xhr.responseHeaders = responseHeaders;
  return { xhr, finish: async () => {
    await act(async () => {
      xhr.onload?.();
      await pending;
    });
  } };
};

test('a tab uploads to the prefixed URL with the bridge token and ignores refresh/auth headers', async () => {
  const token = makeToken('upload');
  await enterTargetMode(token);
  const { xhr, finish } = await runUpload({
    'X-Refreshed-Token': makeToken('rotated', 86400),
    'X-Auth-Error': 'invalid',
  });

  assert.equal(xhr.url, `/r/${PEER}/api/file-tree/projects/p1/files/upload`);
  assert.equal(xhr.headers.Authorization, `Bearer ${token}`);
  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener('auth-session-expired', onExpired);
  await finish();
  window.removeEventListener('auth-session-expired', onExpired);

  assert.equal(expiries, 0);
  assert.equal(localStorage.getItem('auth-token'), null);
});

test('a local upload is unchanged', async () => {
  enterLocalMode();
  const token = makeToken('local');
  localStorage.setItem('auth-token', token);
  const { xhr, finish } = await runUpload();

  assert.equal(xhr.url, '/api/file-tree/projects/p1/files/upload');
  assert.equal(xhr.headers.Authorization, `Bearer ${token}`);
  await finish();
});
