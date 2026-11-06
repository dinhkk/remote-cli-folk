// Server-Sent Events through the mux: events arrive in order and as they are produced (not buffered to the
// end), the answer carries its own content type without the download sandbox, a relay drop ends the stream and
// a new request after the reconnect delivers everything again. A real clone-progress stream closes the loop with
// the Host's own SSE route.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createHostProject, hostGit } from './support/e2e-host-project.js';
import { startHostileHost, type HostileHost } from './support/hostile-host.js';
import { startE2eRelay, type E2eRelay } from './support/e2e-relay.js';
import { type E2eServer, startE2eServer } from './support/e2e-server.js';
import { configureRelay, startWorld, waitForPeerState } from './support/e2e-world.js';
import { sleep, waitUntil } from './support/e2e-util.js';

const EVENTS = 150;
const SSE_PATH = '/api/providers/search/sessions?q=e2e';

type ParsedEvent = { id: string; at: number };

/** Reads an SSE response to its end (or until the connection breaks) and returns the events with arrival times. */
async function readEvents(response: Response, onEvent?: (event: ParsedEvent) => void): Promise<{ events: ParsedEvent[]; broken: boolean }> {
  const events: ParsedEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { events, broken: false };
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const id = /^id: (.*)$/m.exec(block)?.[1];
        if (id !== undefined) {
          const event = { id, at: performance.now() };
          events.push(event);
          onEvent?.(event);
        }
      }
    }
  } catch {
    return { events, broken: true };
  }
}

describe('SSE over the mux (scripted Host)', () => {
  let relay: E2eRelay;
  let controller: E2eServer;
  let host: HostileHost;
  let token = '';

  before(async () => {
    relay = await startE2eRelay();
    controller = await startE2eServer({ name: 'controller' });
    await configureRelay(relay, controller);
    host = await startHostileHost(relay, controller);
    token = (await controller.api(`/api/remote/peers/${host.peerId}/tab-token`, { method: 'POST', body: {} })).json<{ tabToken: string }>().tabToken;
    // One event every 25 ms: a stream that lasts long enough to tell "delivered as produced" from "buffered".
    host.respond(({ stream }) => {
      stream.sendResponse({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
      let next = 0;
      const timer = setInterval(() => {
        if (stream.closed) {
          clearInterval(timer);
          return;
        }
        const last = next === EVENTS - 1;
        stream.writeBody(Buffer.from(`id: ${next}\ndata: {"n":${next}}\n\n`), last);
        next += 1;
        if (last) clearInterval(timer);
      }, 25);
    });
  });
  after(async () => {
    host?.stop();
    await controller?.stop();
    await relay?.stop();
  });

  const open = (): Promise<Response> => fetch(`${controller.baseUrl}/r/${host.peerId}${SSE_PATH}`, { headers: { authorization: `Bearer ${token}` } });

  it('delivers every event in order, as they are produced, with the Host content type and no download sandbox', async () => {
    const response = await open();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(response.headers.get('content-security-policy'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const startedAt = performance.now();
    const { events, broken } = await readEvents(response);
    assert.equal(broken, false);
    assert.deepEqual(events.map((event) => event.id), Array.from({ length: EVENTS }, (_, index) => String(index)));
    const first = events[0].at - startedAt;
    const spread = events[EVENTS - 1].at - events[0].at;
    assert.ok(spread > 1500, `the events were spread over ${spread.toFixed(0)} ms: they were buffered`);
    assert.ok(first < 2000, `the first event took ${first.toFixed(0)} ms`);
  });

  it('a relay drop ends the stream part way; a new request after the reconnect delivers all events in order again', { timeout: 120_000 }, async () => {
    const response = await open();
    const seen: ParsedEvent[] = [];
    const reading = readEvents(response, (event) => seen.push(event));
    await waitUntil(() => seen.length >= 10, '10 events', 10_000);
    relay.cut();
    const { events, broken } = await Promise.race([reading, sleep(20_000).then(() => null)]).then((value) => value ?? { events: seen, broken: null });
    assert.notEqual(broken, null, 'the stream ended when the link dropped');
    assert.ok(events.length < EVENTS, `only ${events.length} of ${EVENTS} events arrived before the drop`);

    await waitForPeerState(controller, host.peerId, 'online', 60_000);
    const again = await waitUntil(async () => {
      const retry = await open().catch(() => null);
      return retry && retry.status === 200 ? retry : null;
    }, 'the stream to be served again', 30_000);
    const second = await readEvents(again);
    assert.equal(second.broken, false);
    assert.deepEqual(second.events.map((event) => event.id), Array.from({ length: EVENTS }, (_, index) => String(index)));
  });
});

describe('SSE over the mux (real Host: clone progress)', () => {
  let world: Awaited<ReturnType<typeof startWorld>>;
  let token = '';

  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
  });
  after(async () => {
    await world?.stop();
  });

  it('streams the progress of a clone from a local repository and ends with a complete event', { timeout: 120_000 }, async () => {
    const source = await createHostProject(world.host, 'clone-source', { repo: true });
    writeFileSync(path.join(source.dir, 'a.txt'), 'a');
    hostGit(source.dir, 'add', '.');
    hostGit(source.dir, 'commit', '-q', '-m', 'second');
    const target = path.join(world.host.home, 'clones');
    mkdirSync(target, { recursive: true });

    const started = await world.viaRemote('/api/projects/clone', { method: 'POST', token, body: { path: target, githubUrl: source.dir.replace(/\\/g, '/') } });
    assert.equal(started.status, 200, started.text);
    const { cloneId } = started.json<{ cloneId: string }>();

    const response = await fetch(`${world.controller.baseUrl}/r/${world.peerId}/api/projects/clone-progress?cloneId=${encodeURIComponent(cloneId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const text = await response.text();
    const types = [...text.matchAll(/^data: (.*)$/gm)].map((match) => (JSON.parse(match[1]) as { type: string; message?: string }));
    assert.ok(types.length >= 1, `events: ${text}`);
    const last = types[types.length - 1];
    assert.equal(last.type, 'complete', `the stream ends with a complete event; got ${JSON.stringify(types.slice(-3))}`);
    assert.ok(types.slice(0, -1).every((event) => event.type === 'progress'), 'progress events come before the end');
  });
});
