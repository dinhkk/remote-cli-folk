import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useRemotePolling } from '@/modules/remote/hooks/useRemotePolling';
import { useRemoteTabs } from '@/modules/remote/hooks/useRemoteTabs';

/**
 * useRemoteTabs is the one place the Remote tab bar learns about pairings. It
 * must cost nothing for someone who never pairs (one request, then silence) and
 * keep up with link state, every 5 s, once a pairing exists.
 */

const peer = { peerId: 'peer_one11111', name: 'Laptop', state: 'online', lastConnectedAt: null };

const calls: Array<{ url: string; method: string }> = [];
let peersReply: () => Response;
let hostReply: () => Response;

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  localStorage.clear();
  peersReply = () => new Response('[]', { status: 200 });
  hostReply = () =>
    new Response(
      JSON.stringify({ acceptEnabled: false, autoOffHours: 0, autoOffAt: null, relay: { state: 'stopped' }, controllers: [] }),
      { status: 200 },
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/tab-token')) {
        return new Response(JSON.stringify({ tabToken: 'a.b.c', expiresAt: 123 }), { status: 200 });
      }
      if (url.endsWith('/host/status')) {
        return hostReply();
      }
      return peersReply();
    }),
  );
});
afterEach(() => {
  setVisibility('visible');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

const peerCalls = () => calls.filter((call) => call.url === '/api/remote/peers');

test('with no pairing it asks once and then stays quiet', async () => {
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  assert.deepEqual(result.current.peers, []);
  assert.equal(result.current.isLoading, false);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  assert.equal(peerCalls().length, 1);
});

test('with a pairing it follows the link state every 5 seconds', async () => {
  peersReply = () => new Response(JSON.stringify([peer]), { status: 200 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.equal(result.current.peers.length, 1);

  peersReply = () => new Response(JSON.stringify([{ ...peer, state: 'offline' }]), { status: 200 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });

  assert.equal(result.current.peers[0]?.state, 'offline');
  assert.equal(peerCalls().length, 2);
});

test('polling stops again when the last pairing is removed', async () => {
  peersReply = () => new Response(JSON.stringify([peer]), { status: 200 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  peersReply = () => new Response('[]', { status: 200 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });
  const settled = peerCalls().length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

  assert.deepEqual(result.current.peers, []);
  assert.equal(peerCalls().length, settled);
});

test('a server without the Remote module (404 or the SPA shell) reads as no pairings and is asked once', async () => {
  peersReply = () => new Response('Not found', { status: 404 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.deepEqual(result.current.peers, []);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  assert.equal(peerCalls().length, 1);
});

test('the SPA shell answering (200 html) is the same as no Remote module', async () => {
  peersReply = () => new Response('<!doctype html><html></html>', { status: 200 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.deepEqual(result.current.peers, []);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  assert.equal(peerCalls().length, 1);
});

test('a transient failure (network, 5xx, 401) keeps the last known peers and retries with backoff', async () => {
  peersReply = () => new Response(JSON.stringify([peer]), { status: 200 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.equal(result.current.peers.length, 1);

  for (const failing of [
    () => {
      throw new Error('network down');
    },
    () => new Response('{}', { status: 502 }),
    () => new Response('{}', { status: 401 }),
  ]) {
    peersReply = failing;
    const before = peerCalls().length;
    await act(async () => {
      await result.current.refresh();
    });
    assert.equal(peerCalls().length, before + 1);
    assert.deepEqual(result.current.peers.map((entry) => entry.peerId), ['peer_one11111'], 'peers survive the failure');
  }

  // Backoff: after a failure the next attempt is not due after the normal 5 s...
  const afterFailures = peerCalls().length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });
  assert.equal(peerCalls().length, afterFailures);
  // ...but it does come, and a healthy answer brings new data.
  peersReply = () => new Response(JSON.stringify([{ ...peer, state: 'offline' }]), { status: 200 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40_000);
  });
  assert.ok(peerCalls().length > afterFailures);
  assert.equal(result.current.peers[0]?.state, 'offline');
});

test('a refusal that asking again cannot fix (403, 409 unsupported mode) is not retried forever', async () => {
  for (const status of [403, 409]) {
    calls.length = 0;
    peersReply = () => new Response(JSON.stringify({ error: { code: 'REMOTE_UNSUPPORTED_MODE' } }), { status });
    const view = renderHook(() => useRemoteTabs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    assert.equal(peerCalls().length, 1, `status ${status}`);
    assert.deepEqual(view.result.current.peers, []);
    view.unmount();
  }
});

test('a first poll that fails keeps retrying until the server answers', async () => {
  peersReply = () => new Response('{}', { status: 503 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.deepEqual(result.current.peers, []);

  peersReply = () => new Response(JSON.stringify([peer]), { status: 200 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  assert.equal(result.current.peers.length, 1);
});

test('polling pauses while the page is hidden and resumes when it is shown', async () => {
  peersReply = () => new Response(JSON.stringify([peer]), { status: 200 });
  renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.equal(peerCalls().length, 1);

  setVisibility('hidden');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  assert.equal(peerCalls().length, 1);

  setVisibility('visible');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.equal(peerCalls().length, 2);
});

test('the tab bar and the Remote settings share one /peers request per cycle', async () => {
  peersReply = () => new Response(JSON.stringify([peer]), { status: 200 });
  renderHook(() => useRemoteTabs());
  renderHook(() => useRemotePolling('full'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const first = peerCalls().length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });

  assert.equal(peerCalls().length - first, 1);
});

test('with the Local indicator mounted too, a server without Remote costs one request in total', async () => {
  peersReply = () => new Response('Not found', { status: 404 });
  renderHook(() => {
    useRemoteTabs();
    useRemotePolling('indicator');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });

  assert.equal(calls.length, 1);
});

test('with Remote present and nothing paired, tab bar and indicator ask peers and status once each', async () => {
  peersReply = () => new Response('[]', { status: 200 });
  renderHook(() => {
    useRemoteTabs();
    useRemotePolling('indicator');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  assert.deepEqual(calls.map((call) => call.url).sort(), ['/api/remote/host/status', '/api/remote/peers']);
});

test('garbage in the reply is ignored rather than rendered', async () => {
  peersReply = () => new Response(JSON.stringify([peer, { peerId: '../evil', name: 'x', state: 'online' }, { nope: 1 }, 'str']), { status: 200 });
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  assert.deepEqual(result.current.peers.map((entry) => entry.peerId), ['peer_one11111']);
});

test('a tab token is requested per peer with a POST and returned as issued', async () => {
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  const grant = await result.current.requestTabToken('peer_one11111');

  assert.deepEqual(grant, { tabToken: 'a.b.c', expiresAt: 123 });
  assert.deepEqual(calls.at(-1), { url: '/api/remote/peers/peer_one11111/tab-token', method: 'POST' });
});

test('a refused tab token request throws so the caller can leave the tab without a token', async () => {
  const { result } = renderHook(() => useRemoteTabs());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

  await assert.rejects(() => result.current.requestTabToken('peer_one11111'));
});
