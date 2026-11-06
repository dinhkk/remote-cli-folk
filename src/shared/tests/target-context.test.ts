import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { frameWindow, unframeWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * The target context is what turns the app into a Remote tab: it reads which
 * paired Host the frame belongs to, keeps that across `navigate()` and reloads
 * (the query string and hash do not survive either), builds every `/r/<peerId>/`
 * URL, and holds the short-lived tab token in a ref rather than in React state.
 */

const PEER = 'peer_abc12345';
const NONCE = 'nonce-0123456789abcdef';

const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};
const tokenExpiringIn = (seconds: number, extra: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ iat: now, exp: now + seconds, ...extra });
};

const load = async (url: string, name = '') => {
  vi.resetModules();
  window.history.replaceState(null, '', url);
  window.name = name;
  return import('@/shared/transport/target-context');
};

beforeEach(() => {
  window.name = '';
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  window.name = '';
  window.history.replaceState(null, '', '/');
});

test('reads the peer from ?target and the nonce from #n=, and remembers the peer in window.name', async () => {
  const ctx = await load(`/?target=${PEER}#n=${NONCE}`);

  assert.deepEqual(ctx.initTargetContext(), { peerId: PEER, nonce: NONCE });
  assert.equal(ctx.isTargetMode(), true);
  assert.equal(window.name, `cloudcli-target:${PEER}`);
  // The nonce is a one-time handshake secret: it must not linger in the address bar.
  assert.equal(window.location.hash, '');
});

test('the nonce is never written to window.name, which any later document in the frame could read', async () => {
  const ctx = await load(`/?target=${PEER}#n=${NONCE}`);
  ctx.initTargetContext();

  assert.equal(window.name.includes(NONCE), false);
});

test('without a target the app stays in local mode and URLs are untouched', async () => {
  const ctx = await load('/session/abc?x=1', 'some-other-name');

  assert.equal(ctx.initTargetContext(), null);
  assert.equal(ctx.isTargetMode(), false);
  assert.equal(window.name, 'some-other-name');
  assert.equal(ctx.httpUrl('/api/projects'), '/api/projects');
  assert.equal(ctx.wsUrl('/ws'), 'ws://localhost:3000/ws');
  assert.equal(ctx.wsProtocols(), undefined);
});

test('after navigate() dropped the query, window.name still says which Host this frame is', async () => {
  const ctx = await load('/session/abc', `cloudcli-target:${PEER}`);

  assert.deepEqual(ctx.initTargetContext(), { peerId: PEER, nonce: null });
  assert.equal(ctx.isTargetMode(), true);
});

test('a peer id that is not a plain token is refused and window.name is left alone', async () => {
  for (const bad of ['../evil', 'a/b', 'a b', '', 'x'.repeat(200), 'peer%2Fx', 'peer.id']) {
    const ctx = await load(`/?target=${encodeURIComponent(bad)}`, 'untouched');
    assert.equal(ctx.initTargetContext(), null, `accepted ${JSON.stringify(bad)}`);
    assert.equal(window.name, 'untouched');
  }

  const ctx = await load('/', 'cloudcli-target:../evil');
  assert.equal(ctx.initTargetContext(), null);
});

test('an unusable nonce is dropped, not trusted', async () => {
  const ctx = await load(`/?target=${PEER}#n=${'z'.repeat(500)}`);

  assert.deepEqual(ctx.initTargetContext(), { peerId: PEER, nonce: null });
});

test('every HTTP path gets the /r/<peerId> prefix exactly once', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();

  assert.equal(ctx.httpUrl('/api/projects?x=1'), `/r/${PEER}/api/projects?x=1`);
  assert.equal(ctx.httpUrl(`/r/${PEER}/api/projects`), `/r/${PEER}/api/projects`);
  // Anything that is not an absolute path is refused (see the hostile-path test below).
  assert.throws(() => ctx.httpUrl('https://example.com/x'), ctx.TargetUrlError);
  assert.throws(() => ctx.httpUrl('//example.com/x'), ctx.TargetUrlError);
});

test('WebSocket URLs follow the page scheme and carry the prefix', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();

  assert.equal(ctx.wsUrl('/ws'), `ws://localhost:3000/r/${PEER}/ws`);
  assert.equal(ctx.wsUrl('/shell'), `ws://localhost:3000/r/${PEER}/shell`);
});

test('the tab token travels as a subprotocol, never in the URL', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  const token = tokenExpiringIn(600);
  ctx.setTabToken(token);

  assert.deepEqual(ctx.wsProtocols(), ['cloudcli-tab', token]);
  assert.equal(ctx.wsUrl('/ws').includes(token), false);
});

test('swapping the token is announced but the ref always holds the latest', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  const seen: Array<string | null> = [];
  ctx.onTabTokenChange((token) => seen.push(token));

  const first = tokenExpiringIn(600);
  const second = tokenExpiringIn(900);
  ctx.setTabToken(first);
  ctx.setTabToken(second);

  assert.equal(ctx.getTabToken(), second);
  assert.deepEqual(seen, [first, second]);
});

test('the signed-in user shown in the tab comes from the token claims', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  assert.equal(ctx.readTabTokenUser(), null);

  ctx.setTabToken(tokenExpiringIn(600, { userId: 7, username: 'alice' }));
  assert.deepEqual(ctx.readTabTokenUser(), { id: 7, username: 'alice' });
});

test('an expired token is never handed out, and asks the page for a new one at most once a minute', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  let requests = 0;
  ctx.onTokenExpired(() => {
    requests += 1;
  });
  ctx.setTabToken(tokenExpiringIn(30));

  assert.notEqual(ctx.getTabToken(), null);
  vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
  assert.equal(ctx.getTabToken(), null);
  assert.equal(ctx.getTabToken(), null);
  assert.equal(requests, 1, 'the second read inside the same minute must not ask again');

  vi.setSystemTime(new Date('2026-01-01T00:02:05Z'));
  assert.equal(ctx.getTabToken(), null);
  assert.equal(requests, 2);
});

test('no token yet reads as null and also asks the page', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  let requests = 0;
  ctx.onTokenExpired(() => {
    requests += 1;
  });

  assert.equal(ctx.getTabToken(), null);
  assert.equal(requests, 1);
});

test('link events reach every subscriber until it unsubscribes', async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  const seen: unknown[] = [];
  const off = ctx.onLinkEvent((event) => seen.push(event));

  ctx.emitLinkEvent({ kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 });
  off();
  ctx.emitLinkEvent({ kind: 'session-expired' });

  assert.deepEqual(seen, [{ kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 }]);
});

// ---------------------------------------------------------------------------
// Target mode exists only inside a frame
// ---------------------------------------------------------------------------

test('a top-level page with ?target= stays Local: a stranger cannot push the app into target mode', async () => {
  unframeWindow();
  try {
    const ctx = await load(`/?target=${PEER}#n=${NONCE}`, 'something');

    assert.equal(ctx.initTargetContext(), null);
    assert.equal(ctx.isTargetMode(), false);
    assert.equal(ctx.httpUrl('/api/projects'), '/api/projects');
    assert.equal(window.name, 'something', 'an unframed page must not be tagged');
  } finally {
    frameWindow();
  }
});

test('a top-level page opened with window.name = cloudcli-target:<id> stays Local and the stale name is cleared', async () => {
  unframeWindow();
  try {
    // window.open(url, 'cloudcli-target:x') from any website lands here.
    const ctx = await load('/', `cloudcli-target:${PEER}`);

    assert.equal(ctx.initTargetContext(), null);
    assert.equal(ctx.isTargetMode(), false);
    assert.equal(window.name, '', 'the stale name would otherwise keep every reload broken');
  } finally {
    frameWindow();
  }
});

test('a framed page with a valid target is a Remote tab', async () => {
  frameWindow();
  const ctx = await load(`/?target=${PEER}#n=${NONCE}`);

  assert.deepEqual(ctx.initTargetContext(), { peerId: PEER, nonce: NONCE });
  assert.equal(ctx.isTargetMode(), true);
});

// ---------------------------------------------------------------------------
// URL policy: only absolute-path requests below /api, /health, /ws, /shell
// ---------------------------------------------------------------------------

const bootTarget = async () => {
  const ctx = await load(`/?target=${PEER}`);
  ctx.initTargetContext();
  return ctx;
};

test('a hostile path is refused in a Remote tab instead of being sent with the token', async () => {
  const ctx = await bootTarget();
  const hostile = [
    '//evil.example/x',
    '///evil.example',
    'https://evil.example/api/x',
    'http://evil.example',
    '\\\\evil.example\\x',
    '/\\evil.example',
    '/api\\..\\x',
    'api/relative',
    './api/x',
    '../x',
    '/api/../../x',
    '/api/a/../b',
    '/api/%2e%2e/x',
    '/api/%2E%2E/x',
    '/api/.%2e/x',
    '/api/./x',
    '/api/%2e/x',
    '/api/a%5c..%5cb',
    '/api/%zz',
    'blob:https://evil.example/uuid',
    'data:text/html,hi',
    'javascript:alert(1)',
    '/etc/passwd',
    '/r/other_peer/api/x',
    '',
    '/',
  ];

  for (const path of hostile) {
    assert.throws(() => ctx.httpUrl(path), ctx.TargetUrlError, `accepted ${JSON.stringify(path)}`);
  }
});

test('an id that stays inside its own segment is allowed; ordinary API paths keep working', async () => {
  const ctx = await bootTarget();

  assert.equal(ctx.httpUrl(`/api/projects/${encodeURIComponent('a b/c')}/files?x=1#top`), `/r/${PEER}/api/projects/a%20b%2Fc/files?x=1#top`);
  assert.equal(ctx.httpUrl('/api/providers/search/sessions?q=..%2F..'), `/r/${PEER}/api/providers/search/sessions?q=..%2F..`);
  assert.equal(ctx.httpUrl('/health'), `/r/${PEER}/health`);
  assert.equal(ctx.httpUrl('/api'), `/r/${PEER}/api`);
  assert.equal(ctx.httpUrl(`/r/${PEER}/api/x`), `/r/${PEER}/api/x`);
  assert.equal(ctx.wsUrl('/ws'), `ws://localhost:3000/r/${PEER}/ws`);
  assert.throws(() => ctx.wsUrl('//evil.example/ws'), ctx.TargetUrlError);
});

test('Local mode leaves every URL exactly as given', async () => {
  const ctx = await load('/');
  ctx.initTargetContext();

  for (const path of ['//evil.example/x', 'https://example.com/x', '/api/../x', 'relative']) {
    assert.equal(ctx.httpUrl(path), path);
  }
});

// ---------------------------------------------------------------------------
// Clock skew: the token's own lifetime, not the browser clock, decides
// ---------------------------------------------------------------------------

test('a token issued by a server whose clock is far from the browser is still used for its lifetime', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  const ctx = await bootTarget();
  let requests = 0;
  ctx.onTokenExpired(() => {
    requests += 1;
  });
  // The browser clock is 2 hours ahead of the server: exp is already "in the past" locally.
  const serverNow = Math.floor(Date.now() / 1000) - 2 * 3600;
  const token = makeToken({ iat: serverNow, exp: serverNow + 900 });
  ctx.setTabToken(token);

  assert.equal(ctx.getTabToken(), token);
  assert.equal(requests, 0);

  vi.setSystemTime(new Date('2026-01-01T12:16:00Z'));
  assert.equal(ctx.getTabToken(), null, 'it still lapses after its real lifetime');
});
