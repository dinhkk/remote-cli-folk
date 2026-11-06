// A relay that drops in the middle of a run (AC-8, 9, 20): the browser socket closes, the link comes back
// within 3 s, `chat.subscribe{lastSeq}` replays exactly what was missed (no loss, no duplicate) and a card
// that was waiting for an answer is still waiting.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { RemoteMessage, RemoteSocket } from './support/e2e-browser-client.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';
import { sleep, waitUntil } from './support/e2e-util.js';

const CHUNKS = 150;

const chunkNumber = (message: RemoteMessage): number | null => {
  const match = /chunk-(\d+)/.exec(JSON.stringify(message));
  return message.kind === 'text' || message.kind === 'stream_delta' ? (match ? Number(match[1]) : null) : null;
};

/** Reopens the tab socket as the browser does: keep trying until the link is back. Resolves with the socket and the time it took. */
const reopen = async (world: RemoteWorld, token: string, since: number): Promise<{ socket: RemoteSocket; ms: number }> => {
  const socket = await waitUntil(() => world.openChat(token).catch(() => null), 'the tab socket to reconnect', 30_000);
  return { socket, ms: Date.now() - since };
};

describe('relay drop in the middle of a run', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld({ hostEnv: { CLAUDE_TOOL_APPROVAL_TIMEOUT_MS: '300000' } });
  });
  after(async () => {
    await world.stop();
  });

  it('closes the browser socket, reconnects within 3 s and replays from lastSeq without loss or duplicates', async () => {
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    chat.send({ type: 'chat.send', sessionId, content: `e2e:stream ${CHUNKS} 30`, options: {} });
    await chat.waitFor((m) => chunkNumber(m) !== null && (chunkNumber(m) ?? 0) >= 20, 'twenty chunks');

    world.relay.cut();
    const cutAt = Date.now();
    await chat.waitForClose(5000);
    const seenBefore = chat.inbox.filter((m) => typeof m.seq === 'number');
    const lastSeq = Math.max(...seenBefore.map((m) => Number(m.seq)));

    const { socket, ms } = await reopen(world, token, cutAt);
    assert.ok(ms <= 3000, `the tab socket was usable again ${ms} ms after the drop`);
    socket.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq }] });
    await socket.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    await socket.waitFor((m) => m.kind === 'complete', 'the run to complete', 30_000);

    const all = [...seenBefore, ...socket.inbox.filter((m) => typeof m.seq === 'number')];
    const seqs = all.map((m) => Number(m.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'no event delivered twice');
    const max = Math.max(...seqs);
    for (let seq = 1; seq <= max; seq += 1) assert.ok(seqs.includes(seq), `seq ${seq} is missing`);
    const chunks = all.map(chunkNumber).filter((value): value is number => value !== null);
    assert.deepEqual([...new Set(chunks)].sort((a, b) => a - b), Array.from({ length: CHUNKS }, (_, index) => index + 1), 'every chunk arrived exactly once');
    socket.close();
  });

  it('a card that waited through the drop is still on offer and Allow still works (AC-20)', async () => {
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    chat.send({ type: 'chat.send', sessionId, content: 'e2e:permission', options: {} });
    const card = await chat.waitFor((m) => m.kind === 'permission_request', 'the card');
    const lastSeq = Math.max(...chat.inbox.filter((m) => typeof m.seq === 'number').map((m) => Number(m.seq)));

    world.relay.cut();
    await chat.waitForClose(5000);
    const { socket } = await reopen(world, token, Date.now());
    socket.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq }] });
    const subscribed = await socket.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    assert.equal(subscribed.pendingPermissions.length, 1);
    assert.equal(subscribed.pendingPermissions[0].requestId, card.requestId);
    assert.equal(subscribed.isProcessing, true);

    socket.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true });
    await socket.waitFor((m) => m.kind === 'complete', 'complete');
    assert.equal(world.host.providerLog().filter((entry) => entry.event === 'approval').at(-1)?.decision.behavior, 'allow');
    socket.close();
  });

  it('repeated drops do not stack up links or leak streams: the Host ends with one session and the tab still works', async () => {
    const token = await world.tabToken();
    for (let round = 0; round < 3; round += 1) {
      world.relay.cut();
      await sleep(300);
      const { socket } = await reopen(world, token, Date.now());
      socket.close();
    }
    const status = (await world.host.api('/api/remote/host/status')).json<{ controllers: Array<{ connected: boolean; streams: number }> }>();
    assert.equal(status.controllers.length, 1);
    assert.equal(status.controllers[0].connected, true);
    assert.ok(status.controllers[0].streams <= 1, `streams still open on the Host: ${status.controllers[0].streams}`);
  });
});
