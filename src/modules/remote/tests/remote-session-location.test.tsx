import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import { RemoteSessionLocation } from '@/modules/remote/RemoteSessionLocation';
import { REMOTE_SESSION_PATH_KEY, readSelectedRemoteTab, writeSelectedRemoteTab } from '@/shared/transport/navigation-storage';

const target = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/shared/transport/target-context', () => ({ isTargetMode: () => target.enabled }));

function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="path">{location.pathname}</output><button onClick={() => navigate('/')}>New Session</button><button onClick={() => navigate('/session/other')}>Other session</button></>;
}
const open = (path = '/') => render(<StrictMode><MemoryRouter initialEntries={[path]}><RemoteSessionLocation><Workspace /></RemoteSessionLocation></MemoryRouter></StrictMode>);

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); target.enabled = true; });

test('target root restores saved session under StrictMode', async () => {
  localStorage.setItem(REMOTE_SESSION_PATH_KEY, '/session/original');
  open();
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/session/original'));
  expect(localStorage.getItem(REMOTE_SESSION_PATH_KEY)).toBe('/session/original');
});

test('explicit deep links take precedence over a remembered session', () => {
  localStorage.setItem(REMOTE_SESSION_PATH_KEY, '/session/old');
  open('/session/new');
  expect(screen.getByTestId('path').textContent).toBe('/session/new');
  expect(localStorage.getItem(REMOTE_SESSION_PATH_KEY)).toBe('/session/new');
});

test('switching conversations updates the location restored after remount', () => {
  const view = open('/session/first');
  fireEvent.click(screen.getByText('Other session'));
  expect(localStorage.getItem(REMOTE_SESSION_PATH_KEY)).toBe('/session/other');
  view.unmount();
  open();
  expect(screen.getByTestId('path').textContent).toBe('/session/other');
});

test('New Session clears the saved route and does not bounce to the previous conversation', () => {
  localStorage.setItem(REMOTE_SESSION_PATH_KEY, '/session/first');
  const view = open();
  fireEvent.click(screen.getByText('New Session'));
  expect(screen.getByTestId('path').textContent).toBe('/');
  expect(localStorage.getItem(REMOTE_SESSION_PATH_KEY)).toBeNull();
  view.unmount();
  open();
  expect(screen.getByTestId('path').textContent).toBe('/');
});

test('Local never restores or overwrites a Host conversation', () => {
  target.enabled = false;
  localStorage.setItem(REMOTE_SESSION_PATH_KEY, '/session/remote');
  open('/session/local');
  expect(screen.getByTestId('path').textContent).toBe('/session/local');
  expect(localStorage.getItem(REMOTE_SESSION_PATH_KEY)).toBe('/session/remote');
});

test.each(['https://example.com', '//example.com', '/session/../api', '/session/id?token=secret', '/session/id#nonce', '{bad json'])('invalid saved path %s is ignored', value => {
  localStorage.setItem(REMOTE_SESSION_PATH_KEY, value);
  open();
  expect(screen.getByTestId('path').textContent).toBe('/');
  expect(localStorage.getItem(REMOTE_SESSION_PATH_KEY)).toBeNull();
});

test('unavailable storage does not block opening a session or selecting a tab', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readSelectedRemoteTab()).toBe('local');
  expect(() => writeSelectedRemoteTab('peer_abc')).not.toThrow();
  open('/session/direct');
  expect(screen.getByTestId('path').textContent).toBe('/session/direct');
});
