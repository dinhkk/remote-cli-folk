/**
 * With Accept on, a Host pairing that completes gets its relay link at once: the Controller that just paired
 * is waiting to connect, and nothing should wait for a status poll or the 60-second tick.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { until, withModuleRig, type ModuleRig } from '../support/remote-module-rig.js';

type Json = Record<string, unknown>;

const hostLinkSockets = (rig: ModuleRig): number => rig.net.sockets.filter((socket) => socket.target.kind === 'link' && socket.target.role === 'host').length;

/** Pairs through the API and returns without ever reading the Host's pairing status after the SAS was entered. */
const pairWithoutPollingTheHost = async (rig: ModuleRig): Promise<void> => {
  const started = await rig.api('/host/pairings/start', { method: 'POST', password: true });
  const { pairingId, code } = started.json<{ pairingId: string; code: string }>();
  const joined = await rig.api('/peers/join', { method: 'POST', body: { code, deviceName: 'My Phone' } });
  const { joinId } = joined.json<{ joinId: string }>();

  let sas = '';
  await until(async () => {
    const view = (await rig.api(`/peers/join/${joinId}`)).json<Json>();
    sas = typeof view.sas === 'string' ? view.sas : '';
    return view.state === 'showing-sas';
  }, 'the SAS on the Controller');
  await until(async () => (await rig.api(`/host/pairings/${pairingId}`)).json<Json>().state === 'awaiting-sas', 'the Host waiting for the SAS');
  const accepted = await rig.api(`/host/pairings/${pairingId}/confirm`, { method: 'POST', body: { sas } });
  assert.deepEqual(accepted.json<Json>(), { ok: true });
  // Only the Controller side is watched from here on.
  await until(async () => (await rig.api(`/peers/join/${joinId}`)).json<Json>().state === 'done', 'the join to finish');
};

describe('Host link when a pairing completes', () => {
  it('opens at once while Accept is on, without any status read of the Host', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      const on = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true }, password: true });
      assert.equal(on.status, 200, on.text());
      assert.equal(hostLinkSockets(rig), 0, 'no pairing yet, no link');

      await pairWithoutPollingTheHost(rig);
      await until(() => hostLinkSockets(rig) === 1, 'the Host link of the new pairing', 3000);
    });
  });

  it('opens nothing when Accept is off', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      await pairWithoutPollingTheHost(rig);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(hostLinkSockets(rig), 0);
    });
  });

  it('switching Accept on opens the links of the existing pairings in the same call', async () => {
    await withModuleRig({}, async (rig) => {
      await rig.configureRelay();
      await pairWithoutPollingTheHost(rig);
      assert.equal(hostLinkSockets(rig), 0);
      const on = await rig.api('/host/accept', { method: 'PUT', body: { enabled: true }, password: true });
      assert.equal(on.status, 200, on.text());
      await until(() => hostLinkSockets(rig) === 1, 'the link opened by the call itself (no status poll in between)', 2000);
    });
  });
});
