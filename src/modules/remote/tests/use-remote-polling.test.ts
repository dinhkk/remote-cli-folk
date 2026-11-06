import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useRemotePolling } from '@/modules/remote/hooks/useRemotePolling';
import { failure, installFakeRemoteApi, reply, settle } from '@/modules/remote/tests/fake-remote-api';

/**
 * One poll feeds the whole Remote UI: `GET /host/status` plus `GET /peers`
 * every 2 s (contracts.md section 2). It backs off while the server fails,
 * sleeps while the tab is hidden, and costs nothing for someone who never
 * turned Remote on.
 */

const HOST = '/api/remote/host/status';
const PEERS = '/api/remote/peers';

const status = (overrides: Record<string, unknown> = {}) => ({
  acceptEnabled: false,
  autoOffHours: 0,
  autoOffAt: null,
  relay: { state: 'stopped' },
  controllers: [],
  ...overrides,
});
const peer = { peerId: 'peer_one11111', name: 'Laptop', state: 'online', lastConnectedAt: null };

let api: ReturnType<typeof installFakeRemoteApi>;

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  api = installFakeRemoteApi({ [`GET ${HOST}`]: reply(status()), [`GET ${PEERS}`]: reply([peer]) });
});
afterEach(() => {
  setVisibility('visible');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('full mode reads host status and peers once per cycle, every 2 seconds', async () => {
  const { result } = renderHook(() => useRemotePolling('full'));
  await settle();

  assert.equal(result.current.snapshot.loaded, true);
  assert.equal(result.current.snapshot.host?.acceptEnabled, false);
  assert.deepEqual(result.current.snapshot.peers.map((entry) => entry.name), ['Laptop']);
  assert.equal(api.to('GET', HOST).length, 1);
  assert.equal(api.to('GET', PEERS).length, 1);

  await settle(2100);
  assert.equal(api.to('GET', HOST).length, 2);
  assert.equal(api.to('GET', PEERS).length, 2);
});

test('two screens using the poll share one request per cycle', async () => {
  renderHook(() => useRemotePolling('full'));
  renderHook(() => useRemotePolling('full'));
  await settle();
  await settle(2100);

  assert.equal(api.to('GET', HOST).length, 2);
  assert.equal(api.to('GET', PEERS).length, 2);
});

test('it backs off while the server fails and returns to 2 seconds once it answers', async () => {
  api.set(`GET ${HOST}`, failure(500, 'REMOTE_INTERNAL'));
  const { result } = renderHook(() => useRemotePolling('full'));
  await settle();
  assert.equal(api.to('GET', HOST).length, 1);
  assert.equal(result.current.snapshot.failure?.status, 500);

  await settle(2100); // the first retry is not due yet: the gap doubled to 4 s
  assert.equal(api.to('GET', HOST).length, 1);
  await settle(2000);
  assert.equal(api.to('GET', HOST).length, 2);

  await settle(4100); // second failure: 8 s
  assert.equal(api.to('GET', HOST).length, 2);
  api.set(`GET ${HOST}`, reply(status()));
  await settle(4000);
  assert.equal(api.to('GET', HOST).length, 3);
  assert.equal(result.current.snapshot.failure, null);

  await settle(2100);
  assert.equal(api.to('GET', HOST).length, 4, 'a healthy answer resets the gap to 2 s');
});

test('the gap stops growing at 30 seconds', async () => {
  api.set(`GET ${HOST}`, failure(500, 'REMOTE_INTERNAL'));
  renderHook(() => useRemotePolling('full'));
  await settle(120_000);
  const before = api.to('GET', HOST).length;

  await settle(30_100);
  assert.equal(api.to('GET', HOST).length, before + 1);
});

test('it stops while the page is hidden and catches up at once when it is shown again', async () => {
  renderHook(() => useRemotePolling('full'));
  await settle();
  assert.equal(api.to('GET', HOST).length, 1);

  setVisibility('hidden');
  await settle(20_000);
  assert.equal(api.to('GET', HOST).length, 1);

  setVisibility('visible');
  await settle();
  assert.equal(api.to('GET', HOST).length, 2);
  await settle(2100);
  assert.equal(api.to('GET', HOST).length, 3);
});

test('indicator mode never asks for peers and goes quiet while Accept is off', async () => {
  const { result } = renderHook(() => useRemotePolling('indicator'));
  await settle();
  await settle(20_000);

  assert.equal(api.to('GET', HOST).length, 1);
  assert.equal(api.to('GET', PEERS).length, 0);
  assert.equal(result.current.snapshot.host?.acceptEnabled, false);
});

test('indicator mode follows the Host while Accept is on and sleeps again when it is turned off', async () => {
  api.set(`GET ${HOST}`, reply(status({ acceptEnabled: true })));
  const { result } = renderHook(() => useRemotePolling('indicator'));
  await settle();
  await settle(2100);
  assert.equal(api.to('GET', HOST).length, 2);

  api.set(`GET ${HOST}`, reply(status({ acceptEnabled: false })));
  await settle(2100);
  const settled = api.to('GET', HOST).length;
  await settle(10_000);
  assert.equal(api.to('GET', HOST).length, settled);

  api.set(`GET ${HOST}`, reply(status({ acceptEnabled: true })));
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(result.current.snapshot.host?.acceptEnabled, true);
  await settle(2100);
  assert.equal(api.to('GET', HOST).length, settled + 2, 'refresh wakes the poll up again');
});

test('a server without the Remote module (404) is reported once and then left alone', async () => {
  api.set(`GET ${HOST}`, { status: 404, body: {} });
  const { result } = renderHook(() => useRemotePolling('full'));
  await settle();

  assert.equal(result.current.snapshot.available, false);
  await settle(30_000);
  assert.equal(api.to('GET', HOST).length, 1);
});

test('the error code of a refused status is kept so the screen can explain it', async () => {
  api.set(`GET ${HOST}`, failure(409, 'REMOTE_UNSUPPORTED_MODE'));
  const { result } = renderHook(() => useRemotePolling('full'));
  await settle();

  assert.deepEqual(result.current.snapshot.failure, { status: 409, code: 'REMOTE_UNSUPPORTED_MODE' });
});

test('malformed peers are dropped instead of rendered and the poll stops when everything unmounts', async () => {
  api.set(`GET ${PEERS}`, reply([peer, { peerId: '../evil', name: 'x', state: 'online' }, 'junk']));
  const view = renderHook(() => useRemotePolling('full'));
  await settle();
  assert.deepEqual(view.result.current.snapshot.peers.map((entry) => entry.peerId), ['peer_one11111']);

  view.unmount();
  const settled = api.to('GET', HOST).length;
  await settle(20_000);
  assert.equal(api.to('GET', HOST).length, settled);
});
