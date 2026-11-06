import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { HostControllerIndicator } from '@/modules/remote/components/HostControllerIndicator';
import { installFakeRemoteApi, reply, settle } from '@/modules/remote/tests/fake-remote-api';

/**
 * FR-17: while this machine accepts Controllers, the Local UI always says how
 * many are connected. When Accept is off (or Remote is not used at all) the
 * indicator is absent, and it is a fixed overlay so it can never move the app.
 */

const HOST = '/api/remote/host/status';

const status = (overrides: Record<string, unknown> = {}) => ({
  acceptEnabled: true,
  autoOffHours: 0,
  autoOffAt: null,
  relay: { state: 'online' },
  controllers: [],
  ...overrides,
});
const controllers = (...flags: boolean[]) =>
  flags.map((connected, index) => ({ pairingId: `p${index}`, name: `C${index}`, connected, connectedAt: null, streams: 0 }));

let api: ReturnType<typeof installFakeRemoteApi>;

beforeEach(() => {
  vi.useFakeTimers();
  api = installFakeRemoteApi({ [`GET ${HOST}`]: reply(status()) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('while Accept is on it counts the connected Controllers, zero included', async () => {
  render(<HostControllerIndicator />);
  await settle();

  assert.equal(screen.getByRole('status').textContent, '0 Controllers connected');
});

test('it reads in the singular for one Controller and ignores pairings that are not linked', async () => {
  api.set(`GET ${HOST}`, reply(status({ controllers: controllers(true, false) })));
  render(<HostControllerIndicator />);
  await settle();

  assert.equal(screen.getByRole('status').textContent, '1 Controller connected');
});

test('it follows Controllers coming and going without a reload', async () => {
  render(<HostControllerIndicator />);
  await settle();

  api.set(`GET ${HOST}`, reply(status({ controllers: controllers(true, true) })));
  await settle(2100);

  assert.equal(screen.getByRole('status').textContent, '2 Controllers connected');
});

test('with Accept off nothing is rendered and the poll goes quiet after the first answer', async () => {
  api.set(`GET ${HOST}`, reply(status({ acceptEnabled: false })));
  const view = render(<HostControllerIndicator />);
  await settle();
  await settle(20_000);

  assert.equal(screen.queryByRole('status'), null);
  assert.equal(view.container.firstChild, null);
  assert.equal(api.to('GET', HOST).length, 1);
});

test('on a server without Remote it renders nothing and asks only once', async () => {
  api.set(`GET ${HOST}`, { status: 404, body: {} });
  const view = render(<HostControllerIndicator />);
  await settle();
  await settle(20_000);

  assert.equal(view.container.firstChild, null);
  assert.equal(api.to('GET', HOST).length, 1);
});

test('in the tab bar it is an in-flow pill, not an overlay, with the full sentence kept for readers and tooltip', async () => {
  api.set(`GET ${HOST}`, reply(status({ controllers: controllers(true) })));
  render(<HostControllerIndicator placement="tabbar" />);
  await settle();

  const pill = screen.getByRole('status');
  assert.doesNotMatch(pill.className, /\bfixed\b|\babsolute\b/);
  assert.match(pill.className, /\bshrink-0\b/);
  assert.equal(pill.getAttribute('title'), '1 Controller connected');
  // Narrow screens see only the count; the sentence is there but visually hidden below `sm`.
  assert.equal(pill.querySelector('.sm\\:hidden')?.textContent, '1');
  assert.equal(pill.querySelector('.sr-only')?.textContent, '1 Controller connected');
  assert.equal(pill.parentElement, document.body.firstElementChild);
});

test('in the tab bar it is still absent while Accept is off', async () => {
  api.set(`GET ${HOST}`, reply(status({ acceptEnabled: false })));
  const view = render(<HostControllerIndicator placement="tabbar" />);
  await settle();

  assert.equal(view.container.firstChild, null);
});

test('it is a fixed, click-through overlay so the layout under it cannot shift', async () => {
  render(<HostControllerIndicator />);
  await settle();

  const wrapper = screen.getByRole('status').parentElement as HTMLElement;
  assert.match(wrapper.className, /\bfixed\b/);
  assert.match(wrapper.className, /pointer-events-none/);
});
