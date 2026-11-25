import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOTP } from 'otpauth';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { openEchoTerminal, timeEcho } from './support/e2e-terminal.js';
import { startWorld } from './support/e2e-world.js';

for (const provider of ['claude', 'codex']) it(`K-12: locking the Controller during a ${provider} turn preserves the Host job and replays completion once`, { timeout: 120_000 }, async () => {
  const preload = fileURLToPath(new URL('./support/fake-codex-preload.mjs', import.meta.url));
  const world = await startWorld(provider === 'codex' ? { hostEnv: { NODE_OPTIONS: `--import=${preload}` } } : {});
  try {
    const enrollment = await world.controller.api('/api/auth/mfa/enroll', { method: 'POST', body: { password: world.controller.password } });
    assert.equal(enrollment.status, 200);
    const totp = new TOTP({ secret: enrollment.json<{ secret: string }>().secret });
    const activationTime = Date.now();
    assert.equal((await world.controller.api('/api/auth/mfa/activate', { method: 'POST', body: { code: totp.generate({ timestamp: activationTime }) } })).status, 200);
    const token = await world.tabToken();
    const created = await world.viaRemote('/api/providers/sessions', { method: 'POST', token, body: { provider, projectPath: world.host.home, initialMessage: 'e2e' } });
    assert.equal(created.status, 201, created.text);
    const sessionId = created.json<{ data: { sessionId: string } }>().data.sessionId;
    const first = await world.openChat(token);
    try {
      first.send({ type: 'chat.send', sessionId, content: 'e2e:stream 12 100', options: {} });
      await first.waitFor(message => message.kind === 'text' || message.kind === 'stream_delta', 'first output');
      assert.equal((await world.controller.api('/api/auth/lock', { method: 'POST', body: {} })).status, 200);
      assert.equal((await first.waitForClose()).code, 4403);
      assert.equal((await world.controller.api('/api/projects')).status, 423);
      const unlocked = await world.controller.api('/api/auth/unlock', { method: 'POST', body: { code: totp.generate({ timestamp: activationTime + 30_000 }) } });
      assert.equal(unlocked.status, 200, unlocked.text);
      const resumed = await world.openChat(await world.tabToken());
      try {
        resumed.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
        await resumed.waitFor(message => message.kind === 'complete', 'replayed or live completion after unlock');
        const received = JSON.stringify(resumed.inbox);
        const start = provider === 'codex' ? 0 : 1;
        for (let index = start; index < start + 12; index++) {
          assert.ok(received.includes(JSON.stringify(`chunk-${index}`)), `missing chunk ${index} after unlock`);
        }

        assert.equal(world.host.providerLog().filter(entry => entry.event === 'prompt' && entry.text === 'e2e:stream 12 100').length, 1);
      } finally { resumed.terminate(); }
    } finally { first.terminate(); }
  } finally { await world.stop(); }
});


it('K-13: locking the Host browser session leaves paired Controller chat and shell usable', { timeout: 120_000 }, async () => {
  const world = await startWorld();
  try {
    const enrollment = await world.host.api('/api/auth/mfa/enroll', { method: 'POST', body: { password: world.host.password } });
    assert.equal(enrollment.status, 200);
    const totp = new TOTP({ secret: enrollment.json<{ secret: string }>().secret });
    assert.equal((await world.host.api('/api/auth/mfa/activate', { method: 'POST', body: { code: totp.generate() } })).status, 200);
    assert.equal((await world.host.api('/api/auth/lock', { method: 'POST', body: {} })).status, 200);
    assert.equal((await world.host.api('/api/projects')).status, 423);
    const token = await world.tabToken();
    assert.equal((await world.viaRemote('/api/projects', { token })).status, 200);
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    try {
      chat.send({ type: 'chat.send', sessionId, content: 'e2e:echo host-browser-locked', options: {} });
      await chat.waitFor(message => message.kind === 'complete', 'Controller chat while Host browser is locked');
      assert.equal(world.host.providerLog().filter(entry => entry.text === 'e2e:echo host-browser-locked').length, 1);
      const shell = await openEchoTerminal(world.host, () => RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token), 'locked-host-shell');
      try { await timeEcho(shell, 'still-connected'); }
      finally { shell.terminate(); }
    } finally { chat.terminate(); }
  } finally { await world.stop(); }
});
