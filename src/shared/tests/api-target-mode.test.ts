import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type * as AuthTokenModule from '@/shared/authToken';
import { AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';
import type * as TargetContextModule from '@/shared/transport/target-context';
import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * In a Remote tab every request is aimed at `/r/<peerId>/...` with the tab
 * token, and nothing a Host says may touch the Controller's own session: a 401
 * relayed from the Host, an `X-Refreshed-Token` header or a token that ran out
 * client-side must never reach `expireAuthSession`/`clearSession`. Local mode is
 * pinned by authenticatedFetch.test.ts, which stays as it was.
 */

const PEER = 'peer_abc12345';

const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};
const tokenExpiringIn = (seconds: number) => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ iat: now - 10, exp: now + seconds });
};

type Loaded = {
  api: typeof ApiModule;
  authToken: typeof AuthTokenModule;
  ctx: typeof TargetContextModule;
};

const loadTarget = async (token: string | null = tokenExpiringIn(600)): Promise<Loaded> => {
  vi.resetModules();
  window.history.replaceState(null, '', `/?target=${PEER}`);
  window.name = '';
  const ctx = await import('@/shared/transport/target-context');
  ctx.initTargetContext();
  ctx.setTabToken(token);
  return {
    ctx,
    api: await import('@/shared/api'),
    authToken: await import('@/shared/authToken'),
  };
};

let lastUrl: string | undefined;
let lastInit: RequestInit | undefined;
let expiries = 0;
let refreshes = 0;
const onExpired = () => {
  expiries += 1;
};
const onRefreshed = () => {
  refreshes += 1;
};

const respondWith = (body: unknown = {}, status = 200, headers: Record<string, string> = {}) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    lastUrl = url;
    lastInit = init;
    return new Response(JSON.stringify(body), { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const sentHeaders = () => (lastInit?.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  localStorage.clear();
  lastUrl = undefined;
  lastInit = undefined;
  expiries = 0;
  refreshes = 0;
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  window.addEventListener('auth-token-refreshed', onRefreshed);
});

afterEach(() => {
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  window.removeEventListener('auth-token-refreshed', onRefreshed);
  vi.unstubAllGlobals();
  window.name = '';
  window.history.replaceState(null, '', '/');
});

test('requests go to /r/<peerId>/ and carry the tab token as the bearer credential', async () => {
  const token = tokenExpiringIn(600);
  const { api } = await loadTarget(token);
  respondWith();

  await api.authenticatedFetch('/api/projects');

  assert.equal(lastUrl, `/r/${PEER}/api/projects`);
  assert.equal(sentHeaders().Authorization, `Bearer ${token}`);
});

test('the bearer is sent even though platform builds normally send none', async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'true');
  const token = tokenExpiringIn(600);
  const { api } = await loadTarget(token);
  respondWith();

  await api.authenticatedFetch('/api/projects');
  vi.unstubAllEnvs();

  assert.equal(sentHeaders().Authorization, `Bearer ${token}`);
});

test('named endpoints are prefixed too, including the auth probes that use a bare fetch', async () => {
  const { api } = await loadTarget();
  respondWith();

  await api.api.git.status('p1');
  assert.equal(lastUrl, `/r/${PEER}/api/git/status?project=p1`);

  await api.api.auth.status();
  assert.equal(lastUrl, `/r/${PEER}/api/auth/status`);
});

test('an X-Refreshed-Token from the Host is neither stored nor announced', async () => {
  const { api } = await loadTarget();
  respondWith({}, 200, { 'X-Refreshed-Token': tokenExpiringIn(86400) });

  await api.authenticatedFetch('/api/projects');

  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(refreshes, 0);
});

test('a 401 relayed from the Host does not end the Controller session', async () => {
  const { api, ctx } = await loadTarget();
  let tokenRequests = 0;
  ctx.onTokenExpired(() => {
    tokenRequests += 1;
  });
  respondWith({ error: 'nope' }, 401, { 'X-Auth-Error': 'invalid' });

  await api.authenticatedFetch('/api/projects');

  assert.equal(expiries, 0);
  assert.equal(localStorage.getItem('auth-token'), null);
  // The tab token itself may be what was refused, so ask the page for a fresh one.
  assert.equal(tokenRequests, 1);
});

test('a 502 from the Controller is reported as a link error, not a sign-out', async () => {
  const { api, ctx } = await loadTarget();
  const events: unknown[] = [];
  ctx.onLinkEvent((event) => events.push(event));
  respondWith({ error: { code: 'REMOTE_UPSTREAM_AUTH', message: 'Host refused' } }, 502);

  const response = await api.authenticatedFetch('/api/projects');

  assert.equal(response.status, 502);
  await vi.waitFor(() => assert.equal(events.length, 1));
  assert.deepEqual(events[0], { kind: 'link-error', code: 'REMOTE_UPSTREAM_AUTH', status: 502 });
  assert.equal(expiries, 0);
});

test('a 503 link-down answer is reported with its registry code', async () => {
  const { api, ctx } = await loadTarget();
  const events: unknown[] = [];
  ctx.onLinkEvent((event) => events.push(event));
  respondWith({ error: { code: 'REMOTE_LINK_DOWN' } }, 503);

  await api.authenticatedFetch('/api/projects');

  await vi.waitFor(() => assert.equal(events.length, 1));
  assert.deepEqual(events[0], { kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 });
});

test('an ordinary error from the Host application is left to the caller', async () => {
  const { api, ctx } = await loadTarget();
  const events: unknown[] = [];
  ctx.onLinkEvent((event) => events.push(event));
  respondWith({ error: 'nothing here' }, 404);

  const response = await api.authenticatedFetch('/api/projects');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(response.status, 404);
  assert.deepEqual(events, []);
});

test('a tab token that expired client-side does not clear the session; the page is asked instead', async () => {
  const { authToken, ctx } = await loadTarget(tokenExpiringIn(-3600));
  let requests = 0;
  ctx.onTokenExpired(() => {
    requests += 1;
  });

  assert.equal(authToken.getStoredAuthToken(), null);

  assert.equal(expiries, 0);
  assert.equal(requests, 1);
});

test('the auth seam is inert in a tab: nothing is stored and expiring is a no-op', async () => {
  const { authToken } = await loadTarget();

  authToken.expireAuthSession();

  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(expiries, 0);
});

test('routes the Host will never serve are answered locally without a request', async () => {
  const { api } = await loadTarget();
  const fetchMock = respondWith();

  for (const call of [
    () => api.api.plugins.list(),
    () => api.api.taskmaster.mcpStatus(),
    () => api.api.settings.notificationPreferences(),
    () => api.api.voice.health(),
    () => api.api.browserUse.settings(),
    () => api.api.system.update(),
    () => api.api.user.savePreferences({ theme: 'dark' }),
    () => api.api.user.preferences(),
    () => api.api.providers.authStatus('claude'),
    () => api.api.providers.cliStatus('claude'),
    () => api.api.providers.updateCli('claude'),
    () => api.api.providers.claudeSettingsPermissions(),
    () => api.api.providers.mcpServers('claude', { scope: 'user' }),
    () => api.api.providers.saveMcpServer('claude', { name: 'x' }),
    () => api.api.providers.deleteMcpServer('claude', 'x', { scope: 'user' }),
    () => api.api.providers.saveGlobalMcpServer({ name: 'x' }),
  ]) {
    const response = await call();
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'REMOTE_FORBIDDEN');
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('an encoded spelling of a blocked route is still blocked, and no request goes out', async () => {
  const { api } = await loadTarget();
  const fetchMock = respondWith();

  for (const path of ['/api/%70lugins', '/api/Plugins/list', '/api/%73ettings/x', '/api/projects/p1/%74askmaster']) {
    const response = await api.authenticatedFetch(path);
    assert.equal(response.status, 403, path);
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('a path the tab refuses to send (host, scheme, climbing) gets a local 403 and the token goes nowhere', async () => {
  const { api } = await loadTarget();
  const fetchMock = respondWith();

  for (const path of ['//evil.example/x', 'https://evil.example/api/x', '\\\\evil.example', '/api/../../x', '/api/%2e%2e/x', 'api/x']) {
    const response = await api.authenticatedFetch(path);
    assert.equal(response.status, 403, path);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'REMOTE_FORBIDDEN');
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('every ordinary route still goes out (provider models and skills included)', async () => {
  const { api } = await loadTarget();
  const fetchMock = respondWith();

  await api.api.projects();
  await api.api.user.drafts();
  await api.api.providers.models('claude');
  await api.api.providers.skills('claude');
  await api.api.providers.capabilities();

  assert.equal(fetchMock.mock.calls.length, 5);
});

test('URL builders for EventSource and XHR are prefixed and never embed the token', async () => {
  const token = tokenExpiringIn(600);
  const { api } = await loadTarget(token);

  const search = api.api.searchConversationsUrl('needle');
  assert.equal(search, `/r/${PEER}/api/providers/search/sessions?q=needle&limit=50`);
  assert.equal(
    api.api.cloneProjectProgressUrl({ cloneId: 'c1' }),
    `/r/${PEER}/api/projects/clone-progress?cloneId=c1`,
  );
  assert.equal(
    api.api.uploadFilesUrl('p1'),
    `/r/${PEER}/api/file-tree/projects/p1/files/upload`,
  );
  assert.equal(
    api.sessionMessagesUrl('s1', { limit: 20, offset: 0 }),
    `/r/${PEER}/api/providers/sessions/s1/messages?limit=20&offset=0`,
  );
  assert.equal(search.includes(token), false);
});

test('without a target nothing changes: same URL, no prefix', async () => {
  vi.resetModules();
  window.history.replaceState(null, '', '/');
  const api = await import('@/shared/api');
  respondWith();

  await api.authenticatedFetch('/api/projects');

  assert.equal(lastUrl, '/api/projects');
  assert.equal(api.api.uploadFilesUrl('p1'), '/api/file-tree/projects/p1/files/upload');
});
