import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * A Remote tab starts on a trimmed profile. Everything it asks for must be
 * addressed to /r/<peerId>/ (or be the bridge to the page), and nothing may ask
 * for a route the Host will refuse (plugins, taskmaster, settings, voice,
 * notifications, browser-use, system), reach out to GitHub or to /health, or
 * register a service worker. Anything else would show up as a wall of 403s on
 * the Host's audit trail and leak the Host's identity to a third party.
 */

// The first test of a file pays for transforming the whole module graph once.
vi.setConfig({ testTimeout: 30_000 });

const PEER = 'peer_abc12345';
const PREFIX = `/r/${PEER}/`;

const makeToken = (ttl = 600) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now, exp: now + ttl, userId: 1, username: 'alice', typ: 'remote-tab', peerId: PEER })}.sig`;
};

type Spy = {
  fetches: Array<{ url: string; method: string }>;
  xhrs: number;
  eventSources: string[];
  sockets: Array<{ url: string; protocols?: string | string[] }>;
  registrations: number;
};
let spy: Spy;

class SpySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: (() => void) | null = null;
  onerror: unknown = null;
  constructor(url: string, protocols?: string | string[]) {
    spy.sockets.push({ url, protocols });
  }
  send() {}
  close() {}
}

const answer = (url: string) => {
  const path = url.replace(PREFIX.slice(0, -1), '');
  if (path.startsWith('/api/user/onboarding-status')) return { hasCompletedOnboarding: true };
  if (path.startsWith('/api/user/drafts')) return { drafts: [] };
  if (path.startsWith('/api/projects')) return [];
  return {};
};

beforeEach(() => {
  spy = { fetches: [], xhrs: 0, eventSources: [], sockets: [], registrations: 0 };
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      spy.fetches.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(answer(url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  vi.stubGlobal('WebSocket', SpySocket);
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      constructor() {
        spy.xhrs += 1;
      }
    },
  );
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(url: string) {
        spy.eventSources.push(url);
      }
      addEventListener() {}
      close() {}
    },
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.name = '';
  window.history.replaceState(null, '', '/');
});

const BLOCKED = /^\/api\/(plugins|taskmaster|settings|voice|notifications|browser-use|browser-use-mcp|system|agent|remote)(\/|$)/;

async function bootTab() {
  vi.resetModules();
  window.history.replaceState(null, '', `/?target=${PEER}`);
  window.name = '';
  const ctx = await import('@/shared/transport/target-context');
  ctx.initTargetContext();
  ctx.setTabToken(makeToken());

  await import('@/modules/i18n');
  const { AuthProvider } = await import('@/modules/auth');
  const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');
  const { PluginsProvider } = await import('@/modules/plugins');
  const { TaskMasterProvider, TasksSettingsProvider } = await import('@/modules/task-master');
  const { useVersionCheck } = await import('@/shared/hooks/useVersionCheck');
  const { useBrowserUseEnabled } = await import('@/modules/browser-use/hooks/useBrowserUseEnabled');

  // What the sidebar and workspace mount at start-up.
  function Probe() {
    useVersionCheck();
    useBrowserUseEnabled();
    return <span data-testid="probe" />;
  }

  const view = render(
    <AuthProvider>
      <WebSocketProvider>
        <PluginsProvider>
          <TasksSettingsProvider>
            <TaskMasterProvider>
              <Probe />
            </TaskMasterProvider>
          </TasksSettingsProvider>
        </PluginsProvider>
      </WebSocketProvider>
    </AuthProvider>,
  );
  await vi.waitFor(() => assert.ok(spy.sockets.length >= 1 || spy.fetches.length >= 1));
  // Let start-up effects, timers and follow-up requests settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return view;
}

test('every request a booting tab makes is addressed to /r/<peerId>/', async () => {
  await bootTab();

  assert.ok(spy.fetches.length > 0, 'the tab should at least have checked onboarding');
  for (const { url } of spy.fetches) {
    assert.equal(url.startsWith(PREFIX), true, `unprefixed request: ${url}`);
  }
  for (const { url, protocols } of spy.sockets) {
    assert.equal(url.startsWith(`ws://localhost:3000${PREFIX}`), true, `unprefixed socket: ${url}`);
    assert.equal(Array.isArray(protocols) && protocols[0] === 'remotecli-tab', true);
  }
  assert.equal(spy.sockets.length >= 1, true, 'the chat socket should have opened');
});

test('a booting tab does not call a route the Host blocks', async () => {
  await bootTab();

  for (const { url, method } of spy.fetches) {
    const path = url.slice(PREFIX.length - 1);
    assert.equal(BLOCKED.test(path), false, `blocked route requested: ${method} ${url}`);
    assert.equal(/\/api\/projects\/[^/]+\/taskmaster/.test(path), false, `taskmaster detail requested: ${url}`);
  }
});

test('preferences are neither read from nor written to the Host', async () => {
  await bootTab();

  assert.equal(spy.fetches.some(({ url }) => url.includes('/api/user/preferences')), false);
});

test('the version check stays off: no GitHub, no /health', async () => {
  await bootTab();

  assert.equal(spy.fetches.some(({ url }) => url.includes('github.com')), false);
  assert.equal(spy.fetches.some(({ url }) => url.endsWith('/health')), false);
});

test('no XHR or EventSource is opened at start-up', async () => {
  await bootTab();

  assert.equal(spy.xhrs, 0);
  assert.deepEqual(spy.eventSources, []);
});

test('the same providers in local mode make their usual unprefixed requests and never call GitHub', async () => {
  vi.resetModules();
  window.history.replaceState(null, '', '/');
  localStorage.setItem('auth-token', makeToken());
  await import('@/modules/i18n');
  const { PluginsProvider } = await import('@/modules/plugins');
  const { useVersionCheck } = await import('@/shared/hooks/useVersionCheck');
  function Probe() {
    useVersionCheck();
    return null;
  }

  render(<PluginsProvider><Probe /></PluginsProvider>);
  await vi.waitFor(() => assert.ok(spy.fetches.some(({ url }) => url === '/api/plugins')));

  assert.ok(spy.fetches.some(({ url }) => url === '/api/auth/version'));
  // No request leaves for a third party, not even for the release check.
  assert.ok(spy.fetches.every(({ url }) => !/^https?:\/\//i.test(url)), JSON.stringify(spy.fetches.map(({ url }) => url)));
});
