import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { requestOpenRemoteTab } from '@/modules/remote/utils/open-remote-tab-request';
import type { RemotePeer } from '@/shared/types';

/**
 * Settings can ask the tab bar to bring a Host's tab to the front (the "Open
 * tab" button of the Hosts list). The two never import each other: the request
 * is a window event the bar listens for.
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
vi.mock('@/modules/remote/utils/tab-bridge', () => ({
  createTabBridge: () => ({ handleFrameLoad: () => 'initial', dispose: () => undefined }),
}));

const { RemoteTabsShell } = await import('@/modules/remote/RemoteTabsShell');

const peer = (peerId: string, name: string): RemotePeer => ({ peerId, name, alias: null, state: 'online', lastConnectedAt: null });

beforeEach(() => {
  HOOK.peers = [peer('peer_one11111', 'Laptop'), peer('peer_two22222', 'Server')];
});

const selectedTab = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;

test('the requested Host comes to the front and its frame is loaded', () => {
  render(<RemoteTabsShell><div>local app</div></RemoteTabsShell>);
  assert.equal(selectedTab(), 'Local');

  act(() => requestOpenRemoteTab('peer_two22222'));

  assert.match(selectedTab() ?? '', /^Server/);
  assert.equal(document.querySelectorAll('iframe').length, 1);
  assert.match(document.querySelector('iframe')?.getAttribute('src') ?? '', /target=peer_two22222/);
});

test('a request for a Host that is not paired changes nothing', () => {
  render(<RemoteTabsShell><div>local app</div></RemoteTabsShell>);

  act(() => requestOpenRemoteTab('peer_gone33333'));

  assert.equal(selectedTab(), 'Local');
  assert.equal(document.querySelector('iframe'), null);
});

test('the listener is removed when the bar unmounts', () => {
  const view = render(<RemoteTabsShell><div>local app</div></RemoteTabsShell>);
  view.unmount();

  assert.doesNotThrow(() => act(() => requestOpenRemoteTab('peer_two22222')));
});
