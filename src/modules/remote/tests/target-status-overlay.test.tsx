import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { TargetStatusOverlay } from '@/modules/remote';
import { emitLinkEvent, initTargetContext } from '@/shared/transport/target-context';
import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * What a Remote tab says when the connection to its Host is the problem: a
 * link error for a relayed 502 (AC-26) or a link that is down (503), and a
 * "session expired" cover when the Controller page could not supply a new tab
 * token. None of these may sign the Controller out.
 */

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/?target=peer_abc12345');
  window.name = '';
  initTargetContext();
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  window.name = '';
  initTargetContext();
});

test('shows nothing while the link is healthy', () => {
  render(<TargetStatusOverlay />);

  assert.equal(screen.queryByRole('alert'), null);
});

test('a relayed 502 from the Host is reported as a link problem, not a login problem', () => {
  render(<TargetStatusOverlay />);

  act(() => emitLinkEvent({ kind: 'link-error', code: 'REMOTE_UPSTREAM_AUTH', status: 502 }));

  const alert = screen.getByRole('alert');
  assert.match(alert.textContent ?? '', /host/i);
  assert.equal(/sign in|log in|password/i.test(alert.textContent ?? ''), false);
});

test('a link that is down says it will keep retrying', () => {
  render(<TargetStatusOverlay />);

  act(() => emitLinkEvent({ kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 }));

  assert.match(screen.getByRole('alert').textContent ?? '', /retry/i);
});

test('a link message goes away by itself, and by hand', () => {
  render(<TargetStatusOverlay />);

  act(() => emitLinkEvent({ kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 }));
  act(() => {
    vi.advanceTimersByTime(9000);
  });
  assert.equal(screen.queryByRole('alert'), null);

  act(() => emitLinkEvent({ kind: 'link-error', code: 'REMOTE_LINK_DOWN', status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  assert.equal(screen.queryByRole('alert'), null);
});

test('an unfamiliar error code still produces a generic link message', () => {
  render(<TargetStatusOverlay />);

  act(() => emitLinkEvent({ kind: 'link-error', code: 'REMOTE_INTERNAL', status: 502 }));

  assert.ok(screen.getByRole('alert'));
});

test('an expired session covers the tab until a token arrives', () => {
  render(<TargetStatusOverlay />);

  act(() => emitLinkEvent({ kind: 'session-expired' }));
  const cover = screen.getByRole('alertdialog');
  assert.match(cover.textContent ?? '', /session expired/i);

  act(() => emitLinkEvent({ kind: 'session-restored' }));
  assert.equal(screen.queryByRole('alertdialog'), null);
});

test('the expired cover offers a way out: reloading the tab, which the Controller page then pairs again', () => {
  let reloads = 0;
  render(<TargetStatusOverlay onReload={() => { reloads += 1; }} />);

  act(() => emitLinkEvent({ kind: 'session-expired' }));
  fireEvent.click(screen.getByRole('button', { name: /reload/i }));

  assert.equal(reloads, 1);
});

test('a cover raised before the overlay mounted is still shown', () => {
  emitLinkEvent({ kind: 'session-expired' });

  render(<TargetStatusOverlay />);

  assert.ok(screen.getByRole('alertdialog'));
});

test('outside a tab the overlay renders nothing at all', () => {
  window.history.replaceState(null, '', '/');
  window.name = '';
  initTargetContext();

  const view = render(<TargetStatusOverlay />);

  assert.equal(view.container.innerHTML, '');
});
