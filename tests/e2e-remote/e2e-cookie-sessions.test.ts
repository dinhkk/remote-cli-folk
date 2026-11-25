import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';

describe('browser session ownership across the real Controller, Host and fake relay', () => {
  let world: RemoteWorld;
  before(async () => { world = await startWorld(); });
  after(async () => { await world?.stop(); });

  it('L-04/K-11: revoking device A closes only its socket while the Host job finishes once for device B', async () => {
    const tokenA = await world.tabToken();
    const sessionId = await world.createSession(tokenA);
    const a = await world.openChat(tokenA);
    await world.controller.relogin();
    const tokenB = await world.tabToken();
    const b = await world.openChat(tokenB);
    try {
      const list = (await world.controller.api('/api/auth/sessions')).json<{ sessions: Array<{ id: string; current: boolean }> }>();
      const deviceA = list.sessions.find((session) => !session.current)!;
      assert.ok(deviceA);
      a.send({ type: 'chat.send', sessionId, content: 'e2e:stream 12 100', options: {} });
      await a.waitFor((message) => message.kind === 'text' || message.kind === 'stream_delta', 'first output');
      b.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
      await b.waitFor((message) => message.kind === 'chat_subscribed', 'device B subscription');
      const revoked = await world.controller.api(`/api/auth/sessions/${deviceA.id}`, { method: 'DELETE', body: {} });
      assert.equal(revoked.status, 200);
      assert.equal((await a.waitForClose()).code, 4401);
      await b.waitFor((message) => message.kind === 'complete', 'completion on the other device');
      assert.equal(b.closed, null);
      assert.equal(world.host.providerLog().filter((entry) => entry.event === 'prompt' && entry.text === 'e2e:stream 12 100').length, 1);
      assert.equal((await world.viaRemote('/api/projects', { token: tokenA })).status, 401);
      assert.equal((await world.viaRemote('/api/projects', { token: tokenB })).status, 200);
    } finally { a.terminate(); b.terminate(); }
  });

  it('K-17: Host restart restores Accept and chat without a browser login on the Host', async () => {
    const token = await world.tabToken();
    await world.host.restart();
    await waitForPeerState(world.controller, world.peerId, 'online', 90_000);
    const chat = await world.openChat(token);
    try {
      const sessionId = await world.createSession(token);
      chat.send({ type: 'chat.send', sessionId, content: 'e2e:echo after-restart', options: {} });
      await chat.waitFor((message) => message.kind === 'complete', 'completion after restart');
      assert.equal(world.host.providerLog().filter((entry) => entry.text === 'e2e:echo after-restart').length, 1);
    } finally { chat.terminate(); }
  });
});

it('K-18: the cookie Controller pairs and chats with an unmodified pre-cookie Host', {
  skip: !process.env.E2E_LEGACY_HOST_ROOT,
  timeout: 120_000,
}, async () => {
  const world = await startWorld({ hostSourceRoot: process.env.E2E_LEGACY_HOST_ROOT, hostLegacyAuth: true });
  try {
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    try {
      chat.send({ type: 'chat.send', sessionId, content: 'e2e:echo legacy-host', options: {} });
      await chat.waitFor((message) => message.kind === 'complete', 'legacy Host completion');
      assert.equal(world.host.providerLog().filter((entry) => entry.text === 'e2e:echo legacy-host').length, 1);
    } finally { chat.terminate(); }
  } finally { await world.stop(); }
});
