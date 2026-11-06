import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * `navigate('/session/:id')` rewrites the URL and the `?target=` query is gone;
 * a reload then loads `/session/:id` with nothing in the query. The frame has
 * to come back in target mode (window.name), not as a Local app that would send
 * the Controller's own credentials to the wrong place.
 */

const PEER = 'peer_abc12345';

afterEach(() => {
  window.name = '';
  window.history.replaceState(null, '', '/');
});

function Navigator({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to);
  }, [navigate, to]);
  return null;
}

test('opening a session and reloading the frame stays in target mode', async () => {
  vi.resetModules();
  window.history.replaceState(null, '', `/?target=${PEER}#n=nonce-0123456789abcdef`);
  window.name = '';
  const first = await import('@/shared/transport/target-context');
  assert.deepEqual(first.initTargetContext(), { peerId: PEER, nonce: 'nonce-0123456789abcdef' });

  // The real router, as App mounts it.
  render(<BrowserRouter><Navigator to="/session/abc123" /></BrowserRouter>);
  await act(async () => undefined);
  assert.equal(window.location.pathname, '/session/abc123');
  assert.equal(window.location.search, '', 'navigate() dropped the query, as expected');

  // "Reload": a fresh JS realm, same window.name, URL as the router left it.
  vi.resetModules();
  const reloaded = await import('@/shared/transport/target-context');
  const target = reloaded.initTargetContext();

  assert.deepEqual(target, { peerId: PEER, nonce: null });
  assert.equal(reloaded.isTargetMode(), true);
  assert.equal(reloaded.httpUrl('/api/projects'), `/r/${PEER}/api/projects`);
});

test('a plain local session URL with no window.name stays local', async () => {
  vi.resetModules();
  window.history.replaceState(null, '', '/session/abc123');
  window.name = '';
  const ctx = await import('@/shared/transport/target-context');

  assert.equal(ctx.initTargetContext(), null);
  assert.equal(ctx.isTargetMode(), false);
});
