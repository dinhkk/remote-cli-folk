import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as StorageShimModule from '@/shared/transport/storage-shim';
import type * as TabChannelModule from '@/shared/transport/tab-channel';
import type * as TargetContextModule from '@/shared/transport/target-context';
import { frameWindow } from '@/shared/tests/framed-window';
import type { TabPortMessage } from '@/shared/types';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * The frame's half of the page <-> tab link. The frame announces itself once
 * (`ready` + nonce), accepts a MessagePort only from `window.parent`, and from
 * then on everything - token, storage mirror, pending count - moves over that
 * port. A frame that never gets a port must come up without a token instead of
 * hanging the boot.
 */

const PEER = 'peer_abc12345';
const NONCE = 'nonce-0123456789abcdef';

const makeToken = (label: string, ttl = 600) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now, exp: now + ttl, label, userId: 3, username: 'alice' })}.sig`;
};

type FakeWindow = EventTarget & {
  parent: { posted: Array<{ message: unknown; target: string }>; postMessage: (m: unknown, t: string) => void };
  name: string;
};

const makeFrameWindow = (): FakeWindow => {
  const target = new EventTarget() as FakeWindow;
  target.parent = {
    posted: [],
    postMessage(message, targetOrigin) {
      this.posted.push({ message, target: targetOrigin });
    },
  };
  target.name = '';
  return target;
};

const deliver = (win: FakeWindow, init: { data: unknown; source: unknown; ports?: MessagePort[] }) => {
  const event = Object.assign(new Event('message'), { data: init.data, source: init.source, ports: init.ports ?? [] });
  win.dispatchEvent(event);
};

type Modules = {
  ctx: typeof TargetContextModule;
  shim: typeof StorageShimModule;
  channel: typeof TabChannelModule;
};

const setup = async (): Promise<Modules> => {
  vi.resetModules();
  window.history.replaceState(null, '', `/?target=${PEER}`);
  window.name = '';
  const ctx = await import('@/shared/transport/target-context');
  ctx.initTargetContext();
  return {
    ctx,
    shim: await import('@/shared/transport/storage-shim'),
    channel: await import('@/shared/transport/tab-channel'),
  };
};

const savedStorage: Record<string, PropertyDescriptor | undefined> = {};
beforeEach(() => {
  savedStorage.localStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  savedStorage.sessionStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
});
afterEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const descriptor = savedStorage[name];
    if (descriptor) Object.defineProperty(window, name, descriptor);
  }
  window.name = '';
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

/** Performs the parent's side of the handshake and returns the parent's end of the port. */
const handshake = (win: FakeWindow) => {
  const channel = new MessageChannel();
  deliver(win, { data: { type: 'port' }, source: win.parent, ports: [channel.port2] });
  return channel.port1;
};

const initMessage = (token = makeToken('first'), snapshot = { local: { activeTab: 'git' }, session: {} }): TabPortMessage => ({
  type: 'init',
  peerId: PEER,
  tabToken: token,
  storageSnapshot: snapshot,
});

test('the frame announces itself to its parent once, carrying the nonce', async () => {
  const { channel, shim } = await setup();
  const win = makeFrameWindow();

  void channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 50 });

  assert.deepEqual(win.parent.posted, [{ message: { type: 'ready', nonce: NONCE }, target: '*' }]);
});

test('init over the port sets the token, fills storage and resolves the boot', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const installed = shim.installStorageShim();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: installed, win: win as unknown as Window, timeoutMs: 1000 });

  const port = handshake(win);
  const token = makeToken('first');
  port.postMessage(initMessage(token));

  assert.equal(await connected, true);
  assert.equal(ctx.getTabToken(), token);
  assert.equal(window.localStorage.getItem('activeTab'), 'git');
});

test('a port offered by anyone but window.parent is ignored', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 40 });

  const stranger = new MessageChannel();
  deliver(win, { data: { type: 'port' }, source: {}, ports: [stranger.port2] });
  stranger.port1.postMessage(initMessage());

  assert.equal(await connected, false);
  assert.equal(ctx.getTabToken(), null);
});

test('a second port, or an init for another peer, is not accepted', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);

  port.postMessage({ ...initMessage(), peerId: 'peer_other999' });
  const intruder = handshake(win);
  intruder.postMessage(initMessage(makeToken('intruder')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.getTabToken(), null);

  port.postMessage(initMessage(makeToken('real')));
  assert.equal(await connected, true);
  assert.equal(JSON.parse(Buffer.from((ctx.getTabToken() as string).split('.')[1] as string, 'base64url').toString()).label, 'real');
});

test('later token messages replace the token in the ref', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);
  port.postMessage(initMessage(makeToken('first')));
  await connected;

  const second = makeToken('second');
  port.postMessage({ type: 'token', token: second });

  await vi.waitFor(() => assert.equal(ctx.getTabToken(), second));
});

test('storage writes, token-expired and pending counts go to the parent over the port', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);
  const received: unknown[] = [];
  port.onmessage = (event) => received.push(event.data);
  port.postMessage(initMessage(makeToken('first', -60)));
  await connected;

  window.localStorage.setItem('permissionMode', 'plan');
  channel.reportPendingCount(2);
  ctx.requestTabToken();

  await vi.waitFor(() => assert.equal(received.length, 3));
  assert.deepEqual(received, [
    { type: 'storage-set', area: 'local', key: 'permissionMode', value: 'plan' },
    { type: 'pending', count: 2 },
    { type: 'token-expired' },
  ]);
});

test('reporting the same pending count twice sends it once', async () => {
  const { channel, shim } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);
  const received: unknown[] = [];
  port.onmessage = (event) => received.push(event.data);
  port.postMessage(initMessage());
  await connected;

  channel.reportPendingCount(1);
  channel.reportPendingCount(1);
  channel.reportPendingCount(0);

  await vi.waitFor(() => assert.equal(received.length, 2));
  assert.deepEqual(received, [{ type: 'pending', count: 1 }, { type: 'pending', count: 0 }]);
});

test('a token request the page never answers ends in a session-expired cover; a late token lifts it', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);
  port.postMessage(initMessage(makeToken('first', -60)));
  await connected;
  const events: string[] = [];
  ctx.onLinkEvent((event) => events.push(event.kind));

  vi.useFakeTimers();
  ctx.requestTabToken();
  await vi.advanceTimersByTimeAsync(10_000);
  assert.deepEqual(events, ['session-expired']);
  vi.useRealTimers();

  port.postMessage({ type: 'token', token: makeToken('renewed') });
  await vi.waitFor(() => assert.deepEqual(events, ['session-expired', 'session-restored']));
});

test('a token that arrives in time prevents the cover', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);
  port.postMessage(initMessage(makeToken('first', -60)));
  await connected;
  const events: string[] = [];
  ctx.onLinkEvent((event) => events.push(event.kind));

  ctx.requestTabToken();
  port.postMessage({ type: 'token', token: makeToken('renewed') });
  await vi.waitFor(() => assert.equal(ctx.getTabToken() !== null, true));
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(15_000);

  assert.equal(events.includes('session-expired'), false);
});

test('a token request made before init (the first fetch failed on the page) is forwarded over the port', async () => {
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  void channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 1000 });
  const port = handshake(win);
  const received: unknown[] = [];
  port.onmessage = (event) => received.push(event.data);

  ctx.requestTabToken();

  await vi.waitFor(() => assert.deepEqual(received, [{ type: 'token-expired' }]));
});

test('an init that arrives after the boot gave up still sets the token and lifts the session-expired cover', async () => {
  vi.useFakeTimers();
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 5000 });
  const port = handshake(win);
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(await connected, false);
  ctx.emitLinkEvent({ kind: 'session-expired' });
  const events: string[] = [];
  ctx.onLinkEvent((event) => events.push(event.kind));
  vi.useRealTimers();

  const late = makeToken('late');
  port.postMessage(initMessage(late));

  await vi.waitFor(() => assert.equal(ctx.getTabToken(), late));
  assert.deepEqual(events, ['session-restored']);
});

test('reportPendingCount is harmless when there is no parent link', async () => {
  const { channel } = await setup();

  assert.doesNotThrow(() => channel.reportPendingCount(3));
});

test('a frame whose parent never answers boots without a token instead of hanging', async () => {
  vi.useFakeTimers();
  const { channel, shim, ctx } = await setup();
  const win = makeFrameWindow();
  const connected = channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 5000 });

  await vi.advanceTimersByTimeAsync(5000);

  assert.equal(await connected, false);
  assert.equal(ctx.getTabToken(), null);
});

test('a document with no parent frame does not even try', async () => {
  const { channel, shim } = await setup();
  const win = makeFrameWindow();
  (win as unknown as { parent: unknown }).parent = win;

  const connected = await channel.connectToParent({ nonce: NONCE, peerId: PEER, shim: shim.installStorageShim(), win: win as unknown as Window, timeoutMs: 5000 });

  assert.equal(connected, false);
});
