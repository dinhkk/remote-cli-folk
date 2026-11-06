import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { RemotePeer } from '@/shared/types';

/**
 * A Remote tab that is not in front still has to say when a tool-permission
 * card is waiting in it: a badge with the count on the tab and `(n)` in front of
 * the browser title, gone as soon as the count is back to 0.
 */

const HOOK = vi.hoisted(() => ({ peers: [] as RemotePeer[] }));
vi.mock('@/modules/remote/hooks/useRemoteTabs', () => ({
  useRemoteTabs: () => ({
    peers: HOOK.peers,
    isLoading: false,
    refresh: async () => undefined,
    requestTabToken: vi.fn(),
  }),
}));

const BRIDGES = vi.hoisted(() => ({ byPeer: new Map<string, (count: number) => void>() }));
vi.mock('@/modules/remote/utils/tab-bridge', () => ({
  createTabBridge: (options: { peerId: string; onPending: (count: number) => void }) => {
    BRIDGES.byPeer.set(options.peerId, options.onPending);
    return { handleFrameLoad: () => 'initial', dispose: () => undefined };
  },
}));

const { RemoteTabsShell } = await import('@/modules/remote/RemoteTabsShell');

const peers: RemotePeer[] = [
  { peerId: 'peer_one11111', name: 'Laptop', alias: null, state: 'online', lastConnectedAt: null },
  { peerId: 'peer_two22222', name: 'Server', alias: null, state: 'online', lastConnectedAt: null },
];

const openTabs = () => {
  render(<RemoteTabsShell><div>local</div></RemoteTabsShell>);
  fireEvent.click(screen.getByRole('tab', { name: /Laptop/ }));
  fireEvent.click(screen.getByRole('tab', { name: /Server/ }));
  // Server is in front; Laptop is hidden.
};
const badgeOf = (name: RegExp) => screen.getByRole('tab', { name }).querySelector('[data-pending-badge]');
const report = (peerId: string, count: number) => act(() => BRIDGES.byPeer.get(peerId)?.(count));

beforeEach(() => {
  HOOK.peers = peers;
  BRIDGES.byPeer.clear();
  document.title = 'RemoteCLI UI';
});
afterEach(() => {
  document.title = '';
});

test('a hidden tab shows a count badge and the browser title gains (n)', () => {
  openTabs();

  report('peer_one11111', 2);

  assert.equal(badgeOf(/Laptop/)?.textContent, '2');
  assert.equal(document.title, '(2) RemoteCLI UI');
});

test('the count disappears when the cards are answered', () => {
  openTabs();
  report('peer_one11111', 2);

  report('peer_one11111', 0);

  assert.equal(badgeOf(/Laptop/), null);
  assert.equal(document.title, 'RemoteCLI UI');
});

test('the tab in front never badges itself, but its count appears once it is hidden', () => {
  openTabs();

  report('peer_two22222', 3);
  assert.equal(badgeOf(/Server/), null);
  assert.equal(document.title, 'RemoteCLI UI');

  fireEvent.click(screen.getByRole('tab', { name: 'Local' }));
  assert.equal(badgeOf(/Server/)?.textContent, '3');
  assert.equal(document.title, '(3) RemoteCLI UI');

  fireEvent.click(screen.getByRole('tab', { name: /Server/ }));
  assert.equal(badgeOf(/Server/), null);
  assert.equal(document.title, 'RemoteCLI UI');
});

test('the title carries the sum over all hidden tabs and is never prefixed twice', () => {
  openTabs();

  report('peer_one11111', 1);
  fireEvent.click(screen.getByRole('tab', { name: 'Local' }));
  report('peer_two22222', 2);
  report('peer_two22222', 4);

  assert.equal(document.title, '(5) RemoteCLI UI');
});
