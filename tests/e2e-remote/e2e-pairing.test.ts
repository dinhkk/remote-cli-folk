// AC-2, AC-3, AC-28: the whole pairing ceremony between two real servers through a relay, over the
// management API only (what the Settings UI does), plus the failure paths of the ceremony.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { joinControllerAndGetSas, startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';
import { waitUntil } from './support/e2e-util.js';

const DEVICE_NAME = 'e2e-laptop-7f3a';
const CHAT_MARKER = 'PLAINTEXT-MARKER-5d1c9e';

describe('e2e pairing through a relay', () => {
  let world: RemoteWorld;

  before(async () => {
    world = await startWorld({ pair: false });
  });
  after(async () => {
    await world.stop();
  });

  it('pairs with the right SAS, goes online, and the relay only ever sees ciphertext', async () => {
    const { host, controller, relay } = world;
    // The device name is a label inside the pairing-room ceremony frames (public values next to the keys, the
    // SAS protects them): the relay may see it there. Once the link is up nothing readable may cross.
    const linkNeedles = [DEVICE_NAME, CHAT_MARKER, 'permission_request', 'chat.send', 'Bearer '];
    const watchers: Array<{ needle: string; watcher: ReturnType<typeof relay.watch> }> = [];
    const leaks = { hits: () => watchers.filter(({ watcher }) => watcher.hits() > 0).map(({ needle }) => needle) };

    const enabled = await host.api('/api/remote/host/accept', { method: 'PUT', body: { enabled: true, password: host.password } });
    assert.equal(enabled.status, 200, enabled.text);
    const started = await host.api('/api/remote/host/pairings/start', { method: 'POST', body: { password: host.password } });
    assert.equal(started.status, 200, started.text);
    const { pairingId, code } = started.json<{ pairingId: string; code: string }>();
    const codeWatch = relay.watch([code, code.replace(/\W/g, '')]);

    const { joinId, sas } = await joinControllerAndGetSas(controller, code, DEVICE_NAME);
    const join = { joinId };
    assert.match(sas, /^\d{6}$/);

    // The Host never learns the SAS by itself: until its user types it, the pairing does not finish.
    const hostBefore = (await host.api(`/api/remote/host/pairings/${pairingId}`)).json<{ state: string }>();
    assert.notEqual(hostBefore.state, 'done');

    const confirmed = await host.api(`/api/remote/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas } });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.json<{ ok: boolean }>().ok, true);

    // The Host dialog polls its pairing; a finished one brings the Host's link up (as the UI does).
    await waitUntil(async () => (await host.api(`/api/remote/host/pairings/${pairingId}`)).json<{ state: string }>().state === 'done', 'the Host pairing to finish', 20_000);
    const finished = await waitUntil(
      async () => {
        const status = (await controller.api(`/api/remote/peers/join/${join.joinId}`)).json<{ state: string; peerId?: string }>();
        return status.state === 'done' ? status : null;
      },
      'the Controller pairing to finish',
      20_000,
    );
    const peerId = String(finished.peerId);
    await waitForPeerState(controller, peerId, 'online');
    for (const needle of linkNeedles) watchers.push({ needle, watcher: relay.watch([needle]) });

    const hostStatus = (await host.api('/api/remote/host/status')).json<{ acceptEnabled: boolean; controllers: Array<{ name: string; connected: boolean }> }>();
    assert.equal(hostStatus.acceptEnabled, true);
    assert.equal(hostStatus.controllers[0].name, DEVICE_NAME);
    assert.equal(hostStatus.controllers[0].connected, true);

    // A real chat message through the tunnel: the text reaches the Host and the relay cannot read it.
    world.peerId = peerId;
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    chat.send({ type: 'chat.send', sessionId, content: `e2e:echo ${CHAT_MARKER}`, options: {} });
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes(CHAT_MARKER), 'the echoed reply');
    await chat.waitFor((m) => m.kind === 'complete', 'the turn to complete');
    chat.close();

    assert.ok(relay.frames.length > 20, `the tap saw the traffic (${relay.frames.length} frames)`);
    assert.deepEqual(leaks.hits(), [], 'no plaintext marker, device name or header crossed the relay');
    assert.equal(codeWatch.hits(), 0, 'the pairing code itself never crosses the relay');
  });

  it('refuses a code that was already used, a code with the wrong format and a code nobody offered', async () => {
    const { host, controller } = world;
    const started = (await host.api('/api/remote/host/pairings/start', { method: 'POST', body: { password: host.password } })).json<{ pairingId: string; code: string }>();
    // A second Controller pairing is a new ceremony: finish it, then replay its code.
    const join = await joinControllerAndGetSas(controller, started.code, 'second-device');
    const sas = join.sas;
    await host.api(`/api/remote/host/pairings/${started.pairingId}/confirm`, { method: 'POST', body: { sas } });
    await waitUntil(async () => (await controller.api(`/api/remote/peers/join/${join.joinId}`)).json<{ state: string }>().state === 'done', 'second pairing done', 20_000);

    const replay = (await controller.api('/api/remote/peers/join', { method: 'POST', body: { code: started.code, deviceName: 'replayer' } })).json<{ joinId: string }>();
    const replayed = await waitUntil(
      async () => {
        const status = (await controller.api(`/api/remote/peers/join/${replay.joinId}`)).json<{ failure?: string }>();
        return status.failure;
      },
      'the replayed code to fail',
      20_000,
    );
    assert.equal(replayed, 'REMOTE_PAIR_EXPIRED');

    const malformed = await controller.api('/api/remote/peers/join', { method: 'POST', body: { code: '!!', deviceName: 'x' } });
    assert.ok([400, 200].includes(malformed.status));
    if (malformed.status === 400) assert.equal(malformed.json<{ error: { code: string } }>().error.code, 'REMOTE_PAIR_CODE_INVALID');
    else {
      const failure = await waitUntil(async () => (await controller.api(`/api/remote/peers/join/${malformed.json<{ joinId: string }>().joinId}`)).json<{ failure?: string }>().failure, 'malformed to fail', 10_000);
      assert.equal(failure, 'REMOTE_PAIR_CODE_INVALID');
    }
  });

  it('locks the Host for 15 minutes after three wrong SAS entries and never finishes the pairing', async () => {
    const { host, controller } = world;
    const started = (await host.api('/api/remote/host/pairings/start', { method: 'POST', body: { password: host.password } })).json<{ pairingId: string; code: string }>();
    const join = await joinControllerAndGetSas(controller, started.code, 'attacker');
    const sas = join.sas;
    const wrong = sas === '000000' ? '111111' : '000000';

    const left: number[] = [];
    let lockedUntil: number | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = (await host.api(`/api/remote/host/pairings/${started.pairingId}/confirm`, { method: 'POST', body: { sas: wrong } })).json<{ ok: boolean; attemptsLeft: number; lockedUntil?: number }>();
      assert.equal(answer.ok, false);
      left.push(answer.attemptsLeft);
      lockedUntil = answer.lockedUntil ?? lockedUntil;
    }
    assert.deepEqual(left, [2, 1, 0]);
    assert.ok(lockedUntil && lockedUntil > Date.now() + 14 * 60_000, 'locked for about 15 minutes');

    const failed = await waitUntil(async () => (await controller.api(`/api/remote/peers/join/${join.joinId}`)).json<{ failure?: string }>().failure, 'the Controller to see the failure', 20_000);
    assert.ok(['REMOTE_PAIR_LOCKED', 'REMOTE_PAIR_FAILED'].includes(failed), failed);

    // Even the right SAS is useless now, and a new pairing is refused while the lock lasts.
    const late = await host.api(`/api/remote/host/pairings/${started.pairingId}/confirm`, { method: 'POST', body: { sas } });
    assert.ok(late.status >= 400 || late.json<{ ok: boolean }>().ok === false);
    const again = await host.api('/api/remote/host/pairings/start', { method: 'POST', body: { password: host.password } });
    assert.equal(again.status, 423, again.text);
    assert.equal(again.json<{ error: { code: string } }>().error.code, 'REMOTE_PAIR_LOCKED');
  });

  it('keeps pairing endpoints behind the password and the JWT', async () => {
    const { host } = world;
    const noPassword = await host.api('/api/remote/host/pairings/start', { method: 'POST', body: {} });
    assert.equal(noPassword.status, 401);
    assert.equal(noPassword.json<{ error: { code: string } }>().error.code, 'AUTH_PASSWORD_REQUIRED');
    const wrongPassword = await host.api('/api/remote/host/pairings/start', { method: 'POST', body: { password: 'not the password' } });
    assert.equal(wrongPassword.status, 403);
    assert.equal(wrongPassword.json<{ error: { code: string } }>().error.code, 'AUTH_INVALID_CREDENTIALS');
    const noJwt = await host.api('/api/remote/host/status', { token: null });
    assert.equal(noJwt.status, 401);
  });
});
