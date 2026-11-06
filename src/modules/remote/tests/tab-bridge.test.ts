import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { createTabBridge } from '@/modules/remote/utils/tab-bridge';
import { purgeRemoteTabStorage } from '@/shared/transport/controller-tab-storage';
import type { RemoteTabTokenGrant, TabPortMessage } from '@/shared/types';

/**
 * The page's half of the page <-> tab link. The page trusts a `ready` only when
 * it comes from this exact frame window with this load's nonce, hands over one
 * MessagePort once, and sends the token over that port only. A frame that was
 * navigated elsewhere, a second `ready`, a wrong nonce or a flood of
 * `token-expired` must not get a token or cost the Controller more than one
 * refresh a minute.
 */

const PEER = 'peer_abc12345';
const NONCE = 'nonce-0123456789abcdef';

const makeToken = (label: string, ttl = 900) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now, exp: now + ttl, label })}.sig`;
};

type Harness = {
  parent: EventTarget;
  frameWindow: { posted: Array<{ message: unknown; target: string; ports: MessagePort[] }>; postMessage: (...args: unknown[]) => void };
  frame: HTMLIFrameElement;
  grants: string[];
  getToken: ReturnType<typeof vi.fn>;
  pending: number[];
  clock: { now: number };
};

const harness = (): Harness => {
  const frameWindow: Harness['frameWindow'] = {
    posted: [],
    postMessage(message, target, ports) {
      frameWindow.posted.push({ message, target: target as string, ports: (ports as MessagePort[]) ?? [] });
    },
  };
  const grants: string[] = [];
  const getToken = vi.fn(async (): Promise<RemoteTabTokenGrant> => {
    const token = makeToken(`grant-${grants.length + 1}`);
    grants.push(token);
    return { tabToken: token, expiresAt: Date.now() + 900_000 };
  });
  return {
    parent: new EventTarget(),
    frameWindow,
    frame: { contentWindow: frameWindow } as unknown as HTMLIFrameElement,
    grants,
    getToken,
    pending: [],
    clock: { now: Date.now() },
  };
};

const start = (h: Harness, overrides: Partial<Parameters<typeof createTabBridge>[0]> = {}) =>
  createTabBridge({
    frame: h.frame,
    peerId: PEER,
    nonce: NONCE,
    getTabToken: h.getToken,
    onPending: (count) => h.pending.push(count),
    parent: h.parent as unknown as Window,
    now: () => h.clock.now,
    ...overrides,
  });

const ready = (h: Harness, init: { source?: unknown; data?: unknown } = {}) => {
  const event = Object.assign(new Event('message'), {
    source: 'source' in init ? init.source : h.frameWindow,
    data: 'data' in init ? init.data : { type: 'ready', nonce: NONCE },
  });
  h.parent.dispatchEvent(event);
};

/** The frame's end of the port, listening for what the page sends. */
const frameEnd = (h: Harness) => {
  const port = h.frameWindow.posted[0]?.ports[0] as MessagePort;
  const received: TabPortMessage[] = [];
  port.onmessage = (event) => received.push(event.data as TabPortMessage);
  return { port, received };
};

beforeEach(() => {
  localStorage.clear();
  purgeRemoteTabStorage();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

test('a ready from the frame with the right nonce gets one port and then init over the port', async () => {
  const h = harness();
  localStorage.setItem(`remote:${PEER}:local:activeTab`, 'git');
  // The session area is never persisted; an entry an older build left behind is not handed over.
  localStorage.setItem(`remote:${PEER}:session:s`, '1');
  localStorage.setItem('remote:peer_other999:local:activeTab', 'chat');
  localStorage.setItem('auth-token', 'controller-jwt');
  start(h);

  ready(h);

  assert.equal(h.frameWindow.posted.length, 1);
  assert.deepEqual(h.frameWindow.posted[0]?.message, { type: 'port' });
  assert.equal(h.frameWindow.posted[0]?.target, '*');
  assert.equal(h.frameWindow.posted[0]?.ports.length, 1);
  const { received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));
  assert.deepEqual(received[0], {
    type: 'init',
    peerId: PEER,
    tabToken: h.grants[0],
    storageSnapshot: { local: { activeTab: 'git' }, session: {} },
  });
});

test('the token is never in the window message, only on the port', () => {
  const h = harness();
  start(h);

  ready(h);

  assert.equal(JSON.stringify(h.frameWindow.posted).includes('tabToken'), false);
});

test('a second ready, a wrong nonce, another sender or a malformed message gets nothing', async () => {
  const h = harness();
  start(h);

  ready(h, { data: { type: 'ready', nonce: 'someone-elses-nonce' } });
  ready(h, { source: { postMessage: () => undefined } });
  ready(h, { source: null });
  ready(h, { data: 'ready' });
  ready(h, { data: { type: 'ready' } });
  ready(h, { data: null });
  assert.equal(h.frameWindow.posted.length, 0);
  assert.equal(h.getToken.mock.calls.length, 0);

  ready(h);
  ready(h);
  ready(h);
  assert.equal(h.frameWindow.posted.length, 1, 'the port is handed over exactly once');
  await vi.waitFor(() => assert.equal(h.getToken.mock.calls.length, 1));
});

test('after the frame loaded another document it never receives a token', () => {
  const h = harness();
  const bridge = start(h);

  assert.equal(bridge.handleFrameLoad(), 'initial');
  // The frame navigated or reloaded itself: a new document, not the one we paired with.
  assert.equal(bridge.handleFrameLoad(), 'foreign');
  ready(h);

  assert.equal(h.frameWindow.posted.length, 0);
  assert.equal(h.getToken.mock.calls.length, 0);
});

test('a frame that navigated away after the handshake loses its port', async () => {
  const h = harness();
  const bridge = start(h);
  ready(h);
  const { received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));
  bridge.handleFrameLoad();

  bridge.handleFrameLoad();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A later refresh would have posted a token; none is sent because the link is closed.
  assert.equal(h.getToken.mock.calls.length, 1);
});

test('token-expired from the frame earns a fresh token, but only once a minute', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  port.postMessage({ type: 'token-expired' });
  await vi.waitFor(() => assert.equal(received.length, 2));
  assert.deepEqual(received[1], { type: 'token', token: h.grants[1] });

  port.postMessage({ type: 'token-expired' });
  port.postMessage({ type: 'token-expired' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.getToken.mock.calls.length, 2, 'a flood must not reach the management API');

  h.clock.now += 61_000;
  port.postMessage({ type: 'token-expired' });
  await vi.waitFor(() => assert.equal(received.length, 3));
  assert.equal(h.getToken.mock.calls.length, 3);
});

test('a refresh that fails sends nothing and does not break the link', async () => {
  const h = harness();
  h.getToken.mockImplementationOnce(async () => ({ tabToken: makeToken('init'), expiresAt: 0 }));
  h.getToken.mockImplementationOnce(async () => {
    throw new Error('management API down');
  });
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  port.postMessage({ type: 'token-expired' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(received.length, 1);
});

// Fake clock for the timers only: MessagePort delivery stays on the real event loop,
// so each step also waits a real moment for the messages to arrive.
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms = 15) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await realWait();
};
const useFakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

test('the token is renewed at about half of its life, without being asked', async () => {
  useFakeClock();
  const h = harness();
  h.getToken.mockImplementation(async () => {
    const token = makeToken(`grant-${h.grants.length + 1}`, 900);
    h.grants.push(token);
    return { tabToken: token, expiresAt: Date.now() + 900_000 };
  });
  start(h, { now: () => Date.now() });
  ready(h);
  const { received } = frameEnd(h);
  await advance(0);
  assert.equal(received.length, 1);

  await advance(440_000);
  assert.equal(received.length, 1, 'not yet');
  await advance(20_000);

  assert.equal(received[1]?.type, 'token');
  assert.equal((received[1] as { token: string }).token, h.grants[1]);
});

test('a browser clock far ahead of the server does not turn renewal into a request every second', async () => {
  useFakeClock();
  const h = harness();
  // The grant says "expires at <2 hours ago>" on the browser clock, but the token itself lives 15 min.
  h.getToken.mockImplementation(async () => {
    const token = makeToken(`grant-${h.grants.length + 1}`, 900);
    h.grants.push(token);
    return { tabToken: token, expiresAt: Date.now() - 2 * 3_600_000 };
  });
  start(h, { now: () => Date.now() });
  ready(h);
  frameEnd(h);
  await advance(0);

  await advance(10 * 60_000);

  assert.ok(h.getToken.mock.calls.length <= 3, `asked ${h.getToken.mock.calls.length} times in 10 minutes`);
});

test('a grant with no usable expiry still renews on a sane schedule, and a huge expiry does not fire at once', async () => {
  useFakeClock();
  const h = harness();
  h.getToken.mockImplementation(async () => {
    h.grants.push('opaque');
    // No claims to read and an expiry about 70 years out: setTimeout(2^31) would fire immediately.
    return { tabToken: 'a.b.c', expiresAt: Date.now() + 70 * 365 * 86_400_000 };
  });
  start(h, { now: () => Date.now() });
  ready(h);
  frameEnd(h);
  await advance(0);

  await advance(60_000);
  assert.equal(h.getToken.mock.calls.length, 1, 'no tight loop');

  await advance(40 * 60_000);
  assert.ok(h.getToken.mock.calls.length >= 2 && h.getToken.mock.calls.length <= 4);
});

// ---------------------------------------------------------------------------
// A failed first token fetch must not leave the tab dead
// ---------------------------------------------------------------------------

test('when the first token fetch fails the bridge retries with backoff and the tab gets init', async () => {
  useFakeClock();
  const h = harness();
  h.getToken.mockImplementationOnce(async () => {
    throw new Error('429');
  });
  h.getToken.mockImplementationOnce(async () => {
    throw new Error('link state');
  });
  start(h, { now: () => Date.now() });
  ready(h);
  const { received } = frameEnd(h);
  await advance(0);
  assert.equal(received.length, 0);
  assert.equal(h.getToken.mock.calls.length, 1);

  await advance(1_000);
  assert.equal(h.getToken.mock.calls.length, 1, 'the first retry waits');
  await advance(5_000);
  assert.equal(h.getToken.mock.calls.length, 2);
  await advance(500);
  assert.equal(h.getToken.mock.calls.length, 2, 'and the second wait is longer');
  await advance(20_000);

  assert.equal(h.getToken.mock.calls.length, 3);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, 'init');
  assert.equal((received[0] as { tabToken: string }).tabToken, h.grants[0]);
});

test('retries stop after a few attempts; a token-expired from the frame then restarts it and is answered with init', async () => {
  useFakeClock();
  const h = harness();
  let failing = true;
  const original = h.getToken.getMockImplementation() as () => Promise<RemoteTabTokenGrant>;
  h.getToken.mockImplementation(async () => {
    if (failing) throw new Error('down');
    return original();
  });
  start(h, { now: () => Date.now() });
  ready(h);
  const { port, received } = frameEnd(h);
  await advance(0);

  await advance(10 * 60_000);
  const attempts = h.getToken.mock.calls.length;
  assert.ok(attempts >= 3 && attempts <= 8, `attempted ${attempts} times`);
  await advance(10 * 60_000);
  assert.equal(h.getToken.mock.calls.length, attempts, 'it gives up instead of retrying forever');

  failing = false;
  port.postMessage({ type: 'token-expired' });
  await advance(0);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, 'init', 'a frame that never got init must be given init, not a bare token');
});

test('the frame can ask for a token before init and the page answers it', async () => {
  useFakeClock();
  const h = harness();
  h.getToken.mockImplementationOnce(async () => {
    throw new Error('down');
  });
  start(h, { now: () => Date.now() });
  ready(h);
  const { port, received } = frameEnd(h);
  await advance(0);

  port.postMessage({ type: 'token-expired' });
  await advance(0);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, 'init');
  await advance(30_000);
  assert.equal(received.filter((message) => message.type === 'init').length, 1, 'init is sent only once');
});

// ---------------------------------------------------------------------------
// A hostile frame cannot flood the page
// ---------------------------------------------------------------------------

test('a flood of messages is dropped after a per-second budget and the link is closed when it keeps up', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  for (let index = 0; index < 5_000; index += 1) {
    port.postMessage({ type: 'pending', count: index % 900 });
  }
  await realWait(150);
  const afterFlood = h.pending.length;
  assert.ok(afterFlood <= 200, `the page handled ${afterFlood} of 5000`);

  port.postMessage({ type: 'pending', count: 7 });
  await realWait(30);
  assert.equal(h.pending.length, afterFlood, 'the link was closed');
});

test('messages beyond the budget of one second are ignored but a calm frame is served again in the next second', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  for (let index = 0; index < 400; index += 1) {
    port.postMessage({ type: 'pending', count: index % 2 === 0 ? 1 : 2 });
  }
  await realWait(60);
  const handled = h.pending.length;
  assert.ok(handled <= 200, `handled ${handled}`);

  h.clock.now += 1_500;
  port.postMessage({ type: 'pending', count: 9 });
  await realWait(30);
  assert.equal(h.pending.at(-1), 9);
});

test('a pending count that did not change is not passed on again', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  for (const count of [3, 3, 3, 4, 4, 3]) port.postMessage({ type: 'pending', count });
  await realWait(40);

  assert.deepEqual(h.pending, [3, 4, 3]);
});

test('a storage flood costs no localStorage rescans: the running count is kept in memory', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));
  port.postMessage({ type: 'storage-set', area: 'local', key: 'warm', value: '1' });
  await realWait(30);

  const originalKey = Storage.prototype.key;
  let keyReads = 0;
  Storage.prototype.key = function patched(this: Storage, index: number) {
    keyReads += 1;
    return originalKey.call(this, index);
  };
  try {
    for (let index = 0; index < 150; index += 1) {
      port.postMessage({ type: 'storage-set', area: 'local', key: `k${index % 10}`, value: String(index) });
    }
    await realWait(80);
  } finally {
    Storage.prototype.key = originalKey;
  }

  assert.equal(keyReads, 0);
  assert.equal(localStorage.getItem(`remote:${PEER}:local:k9`), '149');
});

test('only sane pending counts are reported to the page', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  for (const count of [2, 0, -1, 1.5, '3', Number.NaN, 1_000_000, null]) {
    port.postMessage({ type: 'pending', count });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(h.pending, [2, 0]);
});

test('storage-set lands under remote:<peerId>:local:<key>, the session area stays in memory, nothing else is touched', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  port.postMessage({ type: 'storage-set', area: 'local', key: 'activeTab', value: 'git' });
  port.postMessage({ type: 'storage-set', area: 'session', key: 'k', value: 'v' });
  await vi.waitFor(() => assert.equal(localStorage.getItem(`remote:${PEER}:local:activeTab`), 'git'));

  assert.equal(localStorage.getItem(`remote:${PEER}:session:k`), null, 'session data is never persisted');
  assert.equal(localStorage.getItem('activeTab'), null);

  port.postMessage({ type: 'storage-set', area: 'local', key: 'activeTab', value: null });
  await vi.waitFor(() => assert.equal(localStorage.getItem(`remote:${PEER}:local:activeTab`), null));

  localStorage.setItem('unrelated', 'keep');
  port.postMessage({ type: 'storage-set', area: 'local', key: 'k2', value: 'v2' });
  await vi.waitFor(() => assert.equal(localStorage.getItem(`remote:${PEER}:local:k2`), 'v2'));
  port.postMessage({ type: 'storage-set', area: 'local', key: null, value: null });
  await vi.waitFor(() => assert.equal(localStorage.getItem(`remote:${PEER}:local:k2`), null));
  assert.equal(localStorage.getItem('unrelated'), 'keep');
});

test('a hostile frame cannot fill the Controller storage or write outside its namespace', async () => {
  const h = harness();
  start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  port.postMessage({ type: 'storage-set', area: 'local', key: 'big', value: 'x'.repeat(300_000) });
  port.postMessage({ type: 'storage-set', area: 'local', key: 'k'.repeat(500), value: '1' });
  port.postMessage({ type: 'storage-set', area: 'cookies', key: 'a', value: '1' });
  port.postMessage({ type: 'storage-set', area: 'local', key: 5, value: '1' });
  port.postMessage({ type: 'storage-set', area: 'local', key: 'num', value: 5 });
  for (let i = 0; i < 400; i += 1) {
    port.postMessage({ type: 'storage-set', area: 'local', key: `k${i}`, value: '1' });
  }
  port.postMessage({ type: 'storage-set', area: 'local', key: 'sentinel', value: '1' });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) as string);
  assert.equal(keys.every((key) => key.startsWith(`remote:${PEER}:`)), true);
  assert.equal(localStorage.getItem(`remote:${PEER}:local:big`), null);
  assert.equal(localStorage.getItem(`remote:${PEER}:local:num`), null);
  assert.equal(keys.length <= 200, true, `kept ${keys.length} entries`);
});

test('dispose stops listening and closes the port', async () => {
  const h = harness();
  const bridge = start(h);
  ready(h);
  const { port, received } = frameEnd(h);
  await vi.waitFor(() => assert.equal(received.length, 1));

  bridge.dispose();
  port.postMessage({ type: 'pending', count: 4 });
  ready(h);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(h.pending, []);
  assert.equal(h.frameWindow.posted.length, 1);
});
