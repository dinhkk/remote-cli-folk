import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * In a Remote tab the Controller page has already authenticated the user and
 * hands the frame a tab token, so the frame shows no login or setup screen and
 * never treats a lapsed token as a sign-out: dropping the session there would
 * wipe state that belongs to the Controller's own login.
 */

const PEER = 'peer_abc12345';

const makeToken = (ttl = 600) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now, exp: now + ttl, userId: 7, username: 'alice' })}.sig`;
};

// The first test of a file pays for transforming the whole module graph once.
vi.setConfig({ testTimeout: 30_000 });

const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      urls.push(String(input));
      const body = String(input).includes('onboarding-status') ? { hasCompletedOnboarding: true } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.name = '';
  window.history.replaceState(null, '', '/');
});

const mountTab = async (token: string | null) => {
  vi.resetModules();
  window.history.replaceState(null, '', `/?target=${PEER}`);
  window.name = '';
  const ctx = await import('@/shared/transport/target-context');
  ctx.initTargetContext();
  ctx.setTabToken(token);
  await import('@/modules/i18n');
  const { AuthProvider, ProtectedRoute, useAuth } = await import('@/modules/auth');

  const seen: { value: ReturnType<typeof useAuth> | null } = { value: null };
  // Beside ProtectedRoute, not inside it: a tab without a token never renders its children.
  function Spy() {
    const current = useAuth();
    useEffect(() => {
      seen.value = current;
    });
    return null;
  }
  const view = render(
    <AuthProvider>
      <Spy />
      <ProtectedRoute>
        <div data-testid="workspace">workspace</div>
      </ProtectedRoute>
    </AuthProvider>,
  );
  return { ctx, view, auth: () => seen.value as ReturnType<typeof useAuth> };
};

test('with a tab token the workspace shows straight away: no login form, no auth probes', async () => {
  const { auth } = await mountTab(makeToken());

  await screen.findByTestId('workspace');
  assert.equal(screen.queryByRole('button', { name: /sign in/i }), null);
  assert.equal(screen.queryByLabelText('Username'), null);
  assert.deepEqual(auth().user, { id: 7, username: 'alice' });
  assert.equal(urls.some((url) => url.includes('/api/auth/')), false, `auth routes called: ${urls.join(', ')}`);
  assert.equal(urls.every((url) => url.startsWith(`/r/${PEER}/`)), true);
});

test('the token in the auth context is a stable marker, never the tab token itself', async () => {
  const token = makeToken();
  const { auth, ctx } = await mountTab(token);
  await screen.findByTestId('workspace');
  const before = auth().token;

  act(() => ctx.setTabToken(makeToken(900)));

  assert.notEqual(before, token);
  assert.equal(auth().token, before, 'a renewed tab token must not change what consumers depend on');
});

test('a session-expired event does not sign the tab out', async () => {
  await mountTab(makeToken());
  await screen.findByTestId('workspace');

  act(() => {
    window.dispatchEvent(new Event('auth-session-expired'));
  });

  assert.ok(screen.getByTestId('workspace'));
  assert.equal(screen.queryByLabelText('Username'), null);
});

test('a tab that never received a token shows neither the app nor a login form', async () => {
  const { auth } = await mountTab(null);

  await waitFor(() => assert.equal(auth().isLoading, false));
  assert.equal(screen.queryByTestId('workspace'), null);
  assert.equal(screen.queryByLabelText('Username'), null);
  assert.ok(screen.getByRole('status'));
});

test('a token that arrives late brings the app up', async () => {
  const { auth, ctx } = await mountTab(null);
  await waitFor(() => assert.equal(auth().isLoading, false));

  act(() => ctx.setTabToken(makeToken()));

  await screen.findByTestId('workspace');
});
