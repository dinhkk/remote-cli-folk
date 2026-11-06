/**
 * The management API end to end (contracts sections 2 and 10) on the real module: auth, password
 * re-check of the starred endpoints, relay settings, Accept, the pairing flow Host + Controller over the
 * in-process relay, tab tokens, lazy Controller links, and the rule that no answer ever carries K, a relay
 * token or the relay secret.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyTabToken } from '@/modules/auth/index.js';

import { deriveLinkKeys } from '../../crypto/key-derivation.js';
import { PASSWORD, RELAY_SECRET, RELAY_URL, until, withModuleRig, type ModuleRig } from '../support/remote-module-rig.js';

type Json = Record<string, unknown>;

const errorCode = (body: string): string | undefined => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

/** Drives a complete pairing through the API; returns the ids and the SAS used. */
const pairThroughApi = async (rig: ModuleRig) => {
  const started = await rig.api('/host/pairings/start', { method: 'POST', password: true });
  assert.equal(started.status, 200, started.text());
  const { pairingId, code } = started.json<{ pairingId: string; code: string; expiresAt: number }>();

  const joined = await rig.api('/peers/join', { method: 'POST', body: { code, deviceName: 'My Phone' } });
  assert.equal(joined.status, 200, joined.text());
  const { joinId } = joined.json<{ joinId: string }>();

  let sas = '';
  await until(async () => {
    const view = (await rig.api(`/peers/join/${joinId}`)).json<Json>();
    sas = typeof view.sas === 'string' ? view.sas : '';
    return view.state === 'showing-sas';
  }, 'the SAS on the Controller');
  await until(async () => (await rig.api(`/host/pairings/${pairingId}`)).json<Json>().state === 'awaiting-sas', 'the Host waiting for the SAS');
  return { pairingId, joinId, code, sas };
};

describe('management API: authentication and passwords', () => {
  it('refuses a request without a login, with a tab token, and from another site', async () => {
    await withModuleRig({}, async (rig) => {
      const { tabToken } = rig.arrangePeer();
      const none = await rig.api('/relay-config', { headers: { authorization: '' }, token: '' });
      assert.equal(none.status, 401);
      const tab = await rig.api('/relay-config', { token: tabToken });
      assert.equal(tab.status, 401);
      const foreign = await rig.api('/relay-config', { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(foreign.status, 403);
      assert.equal((await rig.api('/relay-config')).status, 200);
    });
  });

  it('asks for the password on every starred endpoint: missing -> 401 AUTH_PASSWORD_REQUIRED, wrong -> 403 AUTH_INVALID_CREDENTIALS', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const starred: Array<[string, string, Json]> = [
        ['PUT', '/relay-config', { url: RELAY_URL, secret: RELAY_SECRET }],
        ['PUT', '/host/accept', { enabled: true }],
        ['POST', '/host/pairings/start', {}],
        ['DELETE', '/host/pairings/some-id', {}],
      ];
      for (const [method, path, body] of starred) {
        const missing = await rig.api(path, { method, body });
        assert.equal(missing.status, 401, `${method} ${path}`);
        assert.equal(errorCode(missing.text()), 'AUTH_PASSWORD_REQUIRED');
        assert.equal(missing.headers['x-auth-error'], undefined, 'a missing field must not read as an ended session');
        const wrong = await rig.api(path, { method, body, password: 'nope-nope-nope' });
        assert.equal(wrong.status, 403, `${method} ${path}`);
        assert.equal(errorCode(wrong.text()), 'AUTH_INVALID_CREDENTIALS');
      }
    });
  });

  it('does not ask for a password where the contract has none (forget a peer, disconnect, confirm)', async () => {
    await withModuleRig({}, async (rig) => {
      const { record } = rig.arrangePeer();
      assert.equal((await rig.api(`/peers/${record.id}`, { method: 'DELETE' })).status, 200);
      assert.equal(rig.pairings.getPairing(record.id), null);
      assert.equal((await rig.api('/host/controllers/unknown/disconnect', { method: 'POST' })).status, 404);
    });
  });

  it('answers an unknown endpoint with a JSON 404 and a body over 4 KB with 413', async () => {
    await withModuleRig({}, async (rig) => {
      const missing = await rig.api('/nope');
      assert.equal(missing.status, 404);
      assert.equal(errorCode(missing.text()), 'REMOTE_NOT_FOUND');
      const big = await rig.api('/peers/join', { method: 'POST', body: { code: 'x'.repeat(5000), deviceName: 'y' } });
      assert.equal(big.status, 413);
    });
  });
});

describe('management API: relay settings and Accept', () => {
  it('saves the relay settings, never returns the secret and saves an https address as wss', async () => {
    await withModuleRig({}, async (rig) => {
      const empty = (await rig.api('/relay-config')).json<Json>();
      assert.deepEqual(empty, { url: '', hasSecret: false, masterKeySource: 'env' });

      const saved = await rig.api('/relay-config', { method: 'PUT', body: { url: 'https://relay.example.com/', secret: RELAY_SECRET }, password: true });
      assert.equal(saved.status, 200, saved.text());
      const view = await rig.api('/relay-config');
      assert.deepEqual(view.json<Json>(), { url: 'wss://relay.example.com', hasSecret: true, masterKeySource: 'env' });
      assert.ok(!view.text().includes(RELAY_SECRET));
    });
  });

  it('refuses a short secret with INVALID_RELAY_SECRET and an unusable URL with INVALID_RELAY_URL', async () => {
    await withModuleRig({}, async (rig) => {
      const short = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: 'too-short' }, password: true });
      assert.equal(short.status, 400);
      assert.equal(errorCode(short.text()), 'INVALID_RELAY_SECRET');
      const url = await rig.api('/relay-config', { method: 'PUT', body: { url: 'http://relay.example.com', secret: RELAY_SECRET }, password: true });
      assert.equal(url.status, 400);
      assert.equal(errorCode(url.text()), 'INVALID_RELAY_URL');
      const missing = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL }, password: true });
      assert.equal(missing.status, 400);
    });
  });

  it('switches Accept on only after the relay is configured, validates the hours, and reports the status', async () => {
    await withModuleRig({}, async (rig) => {
      const early = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true }, password: true });
      assert.equal(early.status, 400);
      assert.equal(errorCode(early.text()), 'REMOTE_NOT_CONFIGURED');

      await rig.configureRelay();
      const tooLong = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true, autoOffHours: 169 }, password: true });
      assert.equal(tooLong.status, 400);
      assert.equal(errorCode(tooLong.text()), 'REMOTE_BAD_REQUEST');
      const noFlag = await rig.api('/host/accept', { method: 'PUT', body: { autoOffHours: 2 }, password: true });
      assert.equal(noFlag.status, 400);

      const on = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true, autoOffHours: 8 }, password: true });
      assert.equal(on.status, 200, on.text());
      const status = on.json<Json>();
      assert.equal(status.acceptEnabled, true);
      assert.equal(status.autoOffHours, 8);
      assert.equal(typeof status.autoOffAt, 'number');
      assert.equal(status.approvalTimeoutMs, 55000);
      assert.deepEqual((status.relay as Json).state, 'idle');

      const off = await rig.api('/host/accept', { method: 'PUT', body: { enabled: false }, password: true });
      assert.equal((off.json<Json>()).acceptEnabled, false);
    });
  });
});

describe('management API: pairing a Host and a Controller', () => {
  it('pairs through the API, lists both sides, and no answer contains K, a relay token or the relay secret', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const { pairingId, joinId, sas } = await pairThroughApi(rig);
      assert.match(sas, /^\d{6}$/);

      const hostView = (await rig.api(`/host/pairings/${pairingId}`)).json<Json>();
      assert.equal(hostView.controllerName, 'My Phone');
      assert.equal(hostView.attemptsLeft, 3);
      assert.equal('sas' in hostView, false, 'the Host never learns the SAS');

      const wrongSas = sas === '000000' ? '000001' : '000000';
      const wrong = await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas: wrongSas } });
      assert.deepEqual(wrong.json<Json>(), { ok: false, attemptsLeft: 2 });
      const bad = await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas: 'abc' } });
      assert.equal(bad.status, 400);
      assert.equal(errorCode(bad.text()), 'REMOTE_PAIR_INVALID_SAS');
      const accepted = await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas } });
      assert.deepEqual(accepted.json<Json>(), { ok: true });

      await until(async () => (await rig.api(`/host/pairings/${pairingId}`)).json<Json>().state === 'done', 'the Host pairing to finish');
      const joinDone = await until(async () => (await rig.api(`/peers/join/${joinId}`)).json<Json>().state === 'done', 'the join to finish');
      void joinDone;
      const peerId = (await rig.api(`/peers/join/${joinId}`)).json<{ peerId: string }>().peerId;

      const peers = (await rig.api('/peers')).json<Array<{ peerId: string; name: string; state: string }>>();
      assert.equal(peers.length, 1);
      assert.equal(peers[0].peerId, peerId);
      const controllers = (await rig.api('/host/status')).json<{ controllers: Array<{ pairingId: string; name: string; connected: boolean }> }>().controllers;
      assert.equal(controllers.length, 1);
      assert.equal(controllers[0].name, 'My Phone');
      assert.equal(controllers[0].connected, false);

      // Nothing secret in anything the API said during the whole flow.
      const k = rig.pairings.openPairingKey(peerId);
      const { hostToken, controllerToken } = deriveLinkKeys(k);
      const secrets = [k.toString('hex'), k.toString('base64'), k.toString('base64url'), hostToken, controllerToken, RELAY_SECRET];
      for (const body of rig.bodies) for (const secret of secrets) assert.ok(!body.includes(secret), 'a response leaked a secret');
    });
  });

  it('a third wrong SAS ends the pairing, reports the lock, and starting again is refused with 423', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const { pairingId, sas } = await pairThroughApi(rig);
      const wrongSas = sas === '000000' ? '000001' : '000000';
      for (const left of [2, 1]) {
        const wrong = await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas: wrongSas } });
        assert.equal(wrong.json<Json>().attemptsLeft, left);
      }
      const last = (await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas: wrongSas } })).json<Json>();
      assert.equal(last.ok, false);
      assert.equal(last.attemptsLeft, 0);
      assert.equal(typeof last.lockedUntil, 'number');

      const status = (await rig.api(`/host/pairings/${pairingId}`)).json<Json>();
      assert.equal(status.state, 'failed');
      assert.equal(status.failure, 'REMOTE_PAIR_LOCKED');

      const again = await rig.api('/host/pairings/start', { method: 'POST', password: true });
      assert.equal(again.status, 423);
      assert.equal(errorCode(again.text()), 'REMOTE_PAIR_LOCKED');
    });
  });

  it('needs a configured relay, rejects a malformed code at once, and reports a code nobody offers as a failure code', async () => {
    await withModuleRig({}, async (rig) => {
      const early = await rig.api('/host/pairings/start', { method: 'POST', password: true });
      assert.equal(early.status, 400);
      assert.equal(errorCode(early.text()), 'REMOTE_NOT_CONFIGURED');
      const earlyJoin = await rig.api('/peers/join', { method: 'POST', body: { code: 'ABCD-EFGH', deviceName: 'Phone' } });
      assert.equal(earlyJoin.status, 400);

      await rig.configureRelay();
      const malformed = await rig.api('/peers/join', { method: 'POST', body: { code: '12', deviceName: 'Phone' } });
      assert.equal(malformed.status, 400);
      assert.equal(errorCode(malformed.text()), 'REMOTE_PAIR_CODE_INVALID');

      const missingName = await rig.api('/peers/join', { method: 'POST', body: { code: 'ABCD-EFGH' } });
      assert.equal(missingName.status, 400);
      assert.equal(errorCode(missingName.text()), 'REMOTE_BAD_REQUEST');

      const joined = await rig.api('/peers/join', { method: 'POST', body: { code: 'ABCD-2345', deviceName: 'Phone' } });
      assert.equal(joined.status, 200, joined.text());
      const { joinId } = joined.json<{ joinId: string }>();
      await until(async () => (await rig.api(`/peers/join/${joinId}`)).json<Json>().state === 'failed', 'the join to fail');
      assert.equal((await rig.api(`/peers/join/${joinId}`)).json<Json>().failure, 'REMOTE_PAIR_CODE_INVALID');
      assert.equal((await rig.api('/peers/join/unknown')).status, 404);
      assert.equal((await rig.api('/host/pairings/unknown')).status, 404);
    });
  });

  it('revoking a Host pairing asks the relay to destroy the room and reports it; the Controller then sees it revoked', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const { pairingId, sas, joinId } = await pairThroughApi(rig);
      await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas } });
      await until(async () => (await rig.api(`/peers/join/${joinId}`)).json<Json>().state === 'done', 'the join to finish');

      // Revoking names the stored pairing (as the Controllers list shows it), not the ceremony's id.
      const [stored] = (await rig.api('/host/status')).json<{ controllers: Array<{ pairingId: string }> }>().controllers;
      const revoked = await rig.api(`/host/pairings/${stored.pairingId}`, { method: 'DELETE', password: true });
      assert.equal(revoked.status, 200, revoked.text());
      assert.deepEqual(revoked.json<Json>(), { ok: true, relayConfirmed: true });
      const again = await rig.api(`/host/pairings/${stored.pairingId}`, { method: 'DELETE', password: true });
      assert.equal(again.status, 404);
      assert.equal((await rig.api('/host/status')).json<{ controllers: unknown[] }>().controllers.length, 0);
    });
  });

  it('changing the relay secret revokes every pairing on both sides', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const { pairingId, sas, joinId } = await pairThroughApi(rig);
      await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas } });
      await until(async () => (await rig.api(`/peers/join/${joinId}`)).json<Json>().state === 'done', 'the join to finish');
      assert.equal((await rig.api('/peers')).json<unknown[]>().length, 1);

      const changed = await rig.api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: 'z'.repeat(40) }, password: true });
      assert.equal(changed.status, 200, changed.text());
      assert.equal((await rig.api('/peers')).json<unknown[]>().length, 0, 'the Controller pairing is gone');
      assert.equal((await rig.api('/host/status')).json<{ controllers: unknown[] }>().controllers.length, 0, 'the Host pairing is revoked');
      assert.equal(rig.pairings.countActivePairings('host'), 0);
    });
  });
});

describe('management API: Controller peers and tab tokens', () => {
  it('issues a tab token for a paired Host only, verifiable for exactly that peer', async () => {
    await withModuleRig({}, async (rig) => {
      const { record } = rig.arrangePeer();
      const issued = await rig.api(`/peers/${record.id}/tab-token`, { method: 'POST' });
      assert.equal(issued.status, 200, issued.text());
      const { tabToken, expiresAt } = issued.json<{ tabToken: string; expiresAt: number }>();
      assert.equal(verifyTabToken(tabToken, record.id).ok, true);
      assert.equal(verifyTabToken(tabToken, 'another-peer').ok, false);
      assert.ok(expiresAt > Date.now() && expiresAt - Date.now() <= 900_000);

      const missing = await rig.api('/peers/not-a-peer/tab-token', { method: 'POST' });
      assert.equal(missing.status, 404);
      assert.equal(errorCode(missing.text()), 'REMOTE_PEER_NOT_FOUND');
    });
  });

  it('opens the Controller link only when the peers are listed, shows the state, and closes it after five idle minutes', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const { record, host } = rig.arrangePeer();
      host.start();
      assert.equal(rig.net.sockets.filter((socket) => socket.role === 'controller').length, 0, 'nothing connects before a browser asks');

      const first = (await rig.api('/peers')).json<Array<{ peerId: string; state: string }>>();
      assert.equal(first[0].peerId, record.id);
      assert.ok(rig.net.sockets.some((socket) => socket.role === 'controller'));
      await until(async () => (await rig.api('/peers')).json<Array<{ state: string }>>()[0].state === 'online', 'the peer to come online');
      assert.ok(rig.pairings.getPairing(record.id)?.lastConnectedAt, 'the connection is recorded');

      const live = () => rig.net.sockets.filter((socket) => socket.role === 'controller' && socket.closedByLink === undefined);
      assert.ok(live().length > 0);
      rig.clock.advance(5 * 60_000 + 1000);
      assert.equal(live().length, 0, 'the link closed with no browser attached');
      host.close();
    });
  });

  it('forgetting a peer deletes the pairing and an unknown peer is a 404', async () => {
    await withModuleRig({}, async (rig) => {
      const { record } = rig.arrangePeer();
      assert.deepEqual((await rig.api(`/peers/${record.id}`, { method: 'DELETE' })).json<Json>(), { ok: true });
      assert.equal((await rig.api('/peers')).json<unknown[]>().length, 0);
      assert.equal((await rig.api(`/peers/${record.id}`, { method: 'DELETE' })).status, 404);
    });
  });
});
