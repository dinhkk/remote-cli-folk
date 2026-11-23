import assert from 'node:assert/strict';
import { it } from 'node:test';

import { TOTP } from 'otpauth';

import { startWorld, pairServers, waitForPeerState } from './support/e2e-world.js';

it('K-16/T-02: two MFA-enabled servers pair through the fake relay and keep Host chat working', { timeout: 120_000 }, async () => {
  const world = await startWorld({ pair: false });
  try {
    for (const server of [world.controller, world.host]) {
      const enrollment = await server.api('/api/auth/mfa/enroll', { method: 'POST', body: { password: server.password } });
      assert.equal(enrollment.status, 200);
      const { secret } = enrollment.json<{ secret: string }>();
      const activation = await server.api('/api/auth/mfa/activate', { method: 'POST', body: { code: new TOTP({ secret }).generate() } });
      assert.equal(activation.status, 200);
      const status = (await server.api('/api/auth/mfa/status')).json<{ enabled: boolean }>();
      assert.equal(status.enabled, true);
    }
    assert.equal((await world.manage(world.host, '/host/accept', 'PUT', { enabled: true })).status, 200);
    const paired = await pairServers(world.host, world.controller);
    world.peerId = paired.peerId;
    await waitForPeerState(world.controller, world.peerId, 'online');
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    try {
      chat.send({ type: 'chat.send', sessionId, content: 'e2e:echo mfa-pairing', options: {} });
      await chat.waitFor(message => message.kind === 'complete', 'completion through an MFA-enabled Host');
      assert.equal(world.host.providerLog().filter(entry => entry.text === 'e2e:echo mfa-pairing').length, 1);
    } finally { chat.terminate(); }
  } finally { await world.stop(); }
});
