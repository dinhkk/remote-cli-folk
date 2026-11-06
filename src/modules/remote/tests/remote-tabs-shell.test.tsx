import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { RemotePeer } from '@/shared/types';

/**
 * The tab bar exists only when there is a pairing, so a user who never pairs
 * sees the app exactly as before. With pairings it is Local + one tab per Host;
 * every Remote tab is an isolated frame that stays mounted when you switch away.
 */

const HOOK = vi.hoisted(() => ({
  peers: [] as RemotePeer[],
  requestTabToken: vi.fn(),
}));
vi.mock('@/modules/remote/hooks/useRemoteTabs', () => ({
  useRemoteTabs: () => ({
    peers: HOOK.peers,
    isLoading: false,
    refresh: async () => undefined,
    requestTabToken: HOOK.requestTabToken,
  }),
}));

const BRIDGES = vi.hoisted(() => ({ created: [] as Array<{ peerId: string; nonce: string; disposed: boolean }> }));
vi.mock('@/modules/remote/utils/tab-bridge', () => ({
  createTabBridge: (options: { peerId: string; nonce: string }) => {
    const entry = { peerId: options.peerId, nonce: options.nonce, disposed: false };
    BRIDGES.created.push(entry);
    return {
      handleFrameLoad: () => 'initial',
      dispose: () => {
        entry.disposed = true;
      },
    };
  },
}));

const { RemoteTabsShell } = await import('@/modules/remote/RemoteTabsShell');

const peer = (peerId: string, name: string, state: RemotePeer['state'] = 'online', alias: string | null = null): RemotePeer => ({
  peerId,
  name,
  alias,
  state,
  lastConnectedAt: null,
});

let mounts = 0;
function LocalApp() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="local-app">local app</div>;
}

const renderShell = () => render(<RemoteTabsShell><LocalApp /></RemoteTabsShell>);

beforeEach(() => {
  HOOK.peers = [];
  BRIDGES.created.length = 0;
  mounts = 0;
});
afterEach(() => {
  document.title = '';
});

test('with no pairing there is no tab bar and no wrapper box around the app', () => {
  const view = renderShell();

  assert.equal(screen.queryByRole('tablist'), null);
  assert.equal(document.querySelector('iframe'), null);
  assert.ok(screen.getByTestId('local-app'));
  // `display: contents` keeps layout identical to rendering the app directly.
  assert.equal((view.container.firstElementChild as HTMLElement).className.includes('contents'), true);
});

test('with pairings the bar lists Local first, then one tab per Host', () => {
  HOOK.peers = [peer('peer_one11111', 'Laptop'), peer('peer_two22222', 'Server')];
  renderShell();

  const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
  assert.deepEqual(tabs.map((tab) => tab.textContent?.replace(/\d+$/, '').trim()), ['Local', 'Laptop', 'Server']);
  assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true');
  // Frames are created lazily, on first visit.
  assert.equal(document.querySelector('iframe'), null);
});

test('the status pill goes at the end of the tab bar, outside the scrolling tab list, so it cannot cover a tab', () => {
  HOOK.peers = [peer('peer_one11111', 'Laptop'), peer('peer_two22222', 'Server')];
  const placements: string[] = [];
  render(
    <RemoteTabsShell
      indicator={(placement) => {
        placements.push(placement);
        return <div data-testid="pill" />;
      }}
    >
      <LocalApp />
    </RemoteTabsShell>,
  );

  const tablist = screen.getByRole('tablist');
  const pill = screen.getByTestId('pill');
  assert.equal(pill.parentElement, tablist.parentElement);
  assert.equal(tablist.contains(pill), false);
  assert.match(tablist.className, /overflow-x-auto/);
  assert.deepEqual([...new Set(placements)], ['tabbar']);
});

test('with no pairing there is no bar, so the status pill is asked for as a floating overlay', () => {
  const placements: string[] = [];
  render(
    <RemoteTabsShell
      indicator={(placement) => {
        placements.push(placement);
        return <div data-testid="pill" />;
      }}
    >
      <LocalApp />
    </RemoteTabsShell>,
  );

  assert.equal(screen.queryByRole('tablist'), null);
  assert.ok(screen.getByTestId('pill'));
  assert.deepEqual([...new Set(placements)], ['overlay']);
});

test('a Host the user renamed is shown on its tab under that name, not under the device name it declared', () => {
  HOOK.peers = [peer('peer_one11111', 'b3f9c2e81a7d', 'online', 'Home PC'), peer('peer_two22222', 'Server')];
  renderShell();

  const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
  assert.deepEqual(tabs.map((tab) => tab.textContent?.replace(/\d+$/, '').trim()), ['Local', 'Home PC', 'Server']);
  assert.equal(tabs[1]?.querySelector('span[title]')?.getAttribute('title'), 'b3f9c2e81a7d', 'the declared name stays one hover away');
  assert.equal(screen.queryByText('b3f9c2e81a7d'), null);
});

test('the Local app is not remounted when the first pairing appears', () => {
  const view = renderShell();
  assert.equal(mounts, 1);

  HOOK.peers = [peer('peer_one11111', 'Laptop')];
  view.rerender(<RemoteTabsShell><LocalApp /></RemoteTabsShell>);

  assert.equal(screen.getAllByRole('tab').length, 2);
  assert.equal(mounts, 1, 'a remount would drop Local state and open dialogs');
});

test('opening a Remote tab mounts a sandboxed frame without same-origin and with the nonce in the hash', () => {
  HOOK.peers = [peer('peer_one11111', 'Laptop')];
  renderShell();

  fireEvent.click(screen.getByRole('tab', { name: /Laptop/ }));

  const frame = document.querySelector('iframe') as HTMLIFrameElement;
  assert.ok(frame);
  const sandbox = (frame.getAttribute('sandbox') ?? '').split(/\s+/).sort();
  assert.deepEqual(sandbox, ['allow-downloads', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-same-origin', 'allow-scripts']);
  assert.equal(sandbox.includes('allow-same-origin'), true);
  assert.match(frame.getAttribute('src') ?? '', /^\/\?target=peer_one11111#n=[0-9a-f]{32}$/);
  assert.equal(BRIDGES.created.length, 1);
  assert.equal(frame.getAttribute('src'), `/?target=peer_one11111#n=${BRIDGES.created[0]?.nonce}`);
  assert.match(frame.getAttribute('allow') ?? '', /clipboard-write/);
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
});

test('switching tabs keeps the frames mounted and only hides them', () => {
  HOOK.peers = [peer('peer_one11111', 'Laptop'), peer('peer_two22222', 'Server')];
  renderShell();

  fireEvent.click(screen.getByRole('tab', { name: /Laptop/ }));
  const first = document.querySelector('iframe') as HTMLIFrameElement;
  fireEvent.click(screen.getByRole('tab', { name: /Server/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Local' }));

  const frames = Array.from(document.querySelectorAll('iframe'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0], first, 'the first frame must be the same element, not a reload');
  assert.equal(BRIDGES.created.length, 2, 'no bridge was rebuilt by tab switches');
  assert.equal(BRIDGES.created.some((entry) => entry.disposed), false);
  assert.equal(frames.every((frame) => frame.closest('[hidden], .hidden') !== null), true);
  assert.equal(screen.getByTestId('local-app').closest('.hidden'), null);
});

test('the Local app stays mounted while a Remote tab is in front', () => {
  HOOK.peers = [peer('peer_one11111', 'Laptop')];
  renderShell();

  fireEvent.click(screen.getByRole('tab', { name: /Laptop/ }));

  assert.equal(mounts, 1);
  assert.ok(screen.getByTestId('local-app').closest('.hidden'), 'Local is hidden, not unmounted');
});

test('a pairing the Host revoked loses what its tab stored here; a live pairing keeps it', () => {
  localStorage.setItem('remote:peer_revoked11:local:activeTab', 'git');
  localStorage.setItem('remote:peer_online111:local:activeTab', 'chat');
  HOOK.peers = [peer('peer_revoked11', 'Gone', 'revoked'), peer('peer_online111', 'Live', 'online')];

  renderShell();

  assert.equal(localStorage.getItem('remote:peer_revoked11:local:activeTab'), null);
  assert.equal(localStorage.getItem('remote:peer_online111:local:activeTab'), 'chat');
  localStorage.clear();
});

test('a pairing that merely drops out of one poll is not treated as revoked', () => {
  localStorage.setItem('remote:peer_online111:local:activeTab', 'chat');
  HOOK.peers = [peer('peer_online111', 'Live', 'online')];
  const view = renderShell();

  HOOK.peers = [];
  view.rerender(<RemoteTabsShell><LocalApp /></RemoteTabsShell>);

  assert.equal(localStorage.getItem('remote:peer_online111:local:activeTab'), 'chat');
  localStorage.clear();
});

test('each tab shows the state of its link', () => {
  HOOK.peers = [
    peer('peer_online111', 'A', 'online'),
    peer('peer_connect11', 'B', 'connecting'),
    peer('peer_offline11', 'C', 'offline'),
  ];
  renderShell();

  const tabs = screen.getAllByRole('tab');
  assert.deepEqual(tabs.slice(1).map((tab) => tab.getAttribute('data-state')), ['online', 'connecting', 'offline']);
});

test('a revoked, replaced, locked or expired pairing shows its state instead of a frame', () => {
  HOOK.peers = [
    peer('peer_revoked11', 'Revoked', 'revoked'),
    peer('peer_replaced1', 'Replaced', 'replaced'),
    peer('peer_locked111', 'Locked', 'locked'),
    peer('peer_expired11', 'Expired', 'expired'),
  ];
  renderShell();

  for (const [index, label] of [[1, /revoked/i], [2, /another/i], [3, /locked/i], [4, /expired/i]] as const) {
    fireEvent.click(screen.getAllByRole('tab')[index] as HTMLElement);
    assert.ok(screen.getByRole('status').textContent?.match(label), `tab ${index} shows ${label}`);
  }
  assert.equal(document.querySelector('iframe'), null, 'no frame may load for a dead pairing');
});

test('a pairing that disappears closes its tab and falls back to Local', () => {
  HOOK.peers = [peer('peer_one11111', 'Laptop')];
  const view = renderShell();
  fireEvent.click(screen.getByRole('tab', { name: /Laptop/ }));
  assert.ok(document.querySelector('iframe'));

  HOOK.peers = [];
  view.rerender(<RemoteTabsShell><LocalApp /></RemoteTabsShell>);

  assert.equal(document.querySelector('iframe'), null);
  assert.equal(screen.queryByRole('tablist'), null);
  assert.equal(BRIDGES.created[0]?.disposed, true);
  assert.equal(screen.getByTestId('local-app').closest('.hidden'), null);
});
