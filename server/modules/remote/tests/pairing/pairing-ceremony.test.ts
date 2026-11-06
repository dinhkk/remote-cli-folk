import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveLinkKeys, derivePairingKey } from '../../crypto/key-derivation.js';
import {
  PAIR_FRAME_TYPE,
  computeCommitment,
  computeConfirmMac,
  computePairTranscript,
  decodePairAbort,
  isValidDeviceName,
  pairFrameType,
  sanitizeDeviceName,
  sasFromTranscript,
} from '../../pairing/pairing-frames.js';
import { createControllerPairingCeremony, createHostPairingCeremony } from '../../pairing/pairing-ceremony.js';
import { finishWithSas, pumpFrames, runToSas } from '../support/ceremony-driver.js';

type PairingVector = {
  pkCHex: string;
  pkHHex: string;
  ecdhHex: string;
  nonceCHex: string;
  nonceHHex: string;
  commitmentHex: string;
  transcriptHex: string;
  sas: string;
  pairingKeyHex: string;
  hostConfirmHex: string;
  controllerConfirmHex: string;
};

const vector = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../vectors/pairing.json'), 'utf8'),
) as PairingVector;
const hex = (value: string): Buffer => Buffer.from(value, 'hex');

test('fixed vectors from the independent reference: commitment, transcript, SAS, K and both confirmations', () => {
  const [pkC, pkH, nc, nh] = [vector.pkCHex, vector.pkHHex, vector.nonceCHex, vector.nonceHHex].map(hex);
  assert.equal(computeCommitment(nh, pkH, pkC).toString('hex'), vector.commitmentHex);
  const transcript = computePairTranscript(pkC, pkH, nc, nh);
  assert.equal(transcript.toString('hex'), vector.transcriptHex);
  assert.equal(sasFromTranscript(transcript), vector.sas);
  const k = derivePairingKey(hex(vector.ecdhHex), nc, nh);
  assert.equal(k.toString('hex'), vector.pairingKeyHex);
  const { macKey } = deriveLinkKeys(k);
  assert.equal(computeConfirmMac('host', macKey, transcript).toString('hex'), vector.hostConfirmHex);
  assert.equal(computeConfirmMac('controller', macKey, transcript).toString('hex'), vector.controllerConfirmHex);
  assert.notEqual(vector.hostConfirmHex, vector.controllerConfirmHex, 'the two directions must not be interchangeable');
});

test('the SAS is always six digits, zero padded', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const sas = sasFromTranscript(Buffer.alloc(32, i));
    assert.match(sas, /^\d{6}$/);
    seen.add(sas);
  }
  assert.ok(seen.size > 250);
  assert.equal(sasFromTranscript(Buffer.alloc(32, 0)), '000000');
});

test('a legitimate exchange gives both sides the same K and the names', () => {
  const pair = runToSas({ host: 'Office PC', controller: 'My Laptop' });
  assert.equal(pair.host.state, 'awaiting-sas');
  assert.equal(pair.controller.state, 'showing-sas');
  assert.match(pair.controller.sas ?? '', /^\d{6}$/);
  assert.equal(pair.host.controllerName, 'My Laptop');
  assert.equal(pair.controller.hostName, 'Office PC');

  finishWithSas(pair, pair.controller.sas as string);
  assert.equal(pair.host.state, 'done');
  assert.equal(pair.controller.state, 'done');

  const hostResult = pair.host.takeResult();
  const controllerResult = pair.controller.takeResult();
  assert.ok(hostResult && controllerResult);
  assert.equal(hostResult.k.length, 32);
  assert.ok(hostResult.k.equals(controllerResult.k), 'both sides derive the same K');
  assert.equal(hostResult.peerName, 'My Laptop');
  assert.equal(controllerResult.peerName, 'Office PC');
  assert.equal(pair.host.takeResult(), null, 'the key is handed out once');
});

test('two ceremonies never produce the same K or SAS', () => {
  const a = runToSas();
  const b = runToSas();
  finishWithSas(a, a.controller.sas as string);
  finishWithSas(b, b.controller.sas as string);
  assert.ok(!(a.host.takeResult() as { k: Buffer }).k.equals((b.host.takeResult() as { k: Buffer }).k));
});

test('the Host side exposes no SAS and cannot build one before it has seen Nc', () => {
  const host = createHostPairingCeremony({ hostName: 'Office PC' });
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  assert.equal('sas' in host, false);
  for (const value of Object.values(host)) {
    if (typeof value !== 'function') assert.doesNotMatch(String(value), /^\d{6}$/, 'no property of the Host ceremony may hold a SAS');
  }

  // After HELLO the Host has answered but holds no Nc yet: any entry is "not ready", nothing is consumed.
  const [hostKey] = host.receive(controller.start());
  assert.equal(host.state, 'exchanging');
  assert.deepEqual(host.submitSas('123456'), { status: 'not-ready' });
  assert.equal(host.attemptsLeft, 3);
  assert.equal(pairFrameType(hostKey), PAIR_FRAME_TYPE.hostKey);
});

test('a wrong SAS lowers attemptsLeft; the third wrong entry aborts the ceremony and tells the Controller', () => {
  const pair = runToSas();
  const real = pair.controller.sas as string;
  const wrong = real === '000000' ? '000001' : '000000';

  assert.equal(pair.host.attemptsLeft, 3);
  const first = pair.host.submitSas(wrong);
  assert.deepEqual({ status: first.status, left: first.status === 'rejected' ? first.attemptsLeft : -1 }, { status: 'rejected', left: 2 });
  assert.equal(pair.host.state, 'awaiting-sas');
  const second = pair.host.submitSas(wrong);
  assert.equal(second.status === 'rejected' ? second.attemptsLeft : -1, 1);

  const third = pair.host.submitSas(wrong);
  assert.equal(third.status, 'rejected');
  assert.equal(third.status === 'rejected' ? third.attemptsLeft : -1, 0);
  assert.equal(pair.host.state, 'failed');
  assert.equal(pair.host.failure, 'sas-attempts-exhausted');
  assert.equal(pair.host.takeResult(), null);

  const abort = third.status === 'rejected' ? third.frames : [];
  assert.equal(abort.length, 1);
  assert.equal(decodePairAbort(abort[0]), 'sas-attempts-exhausted');
  pair.controller.receive(abort[0]);
  assert.equal(pair.controller.state, 'failed');
  assert.equal(pair.controller.failure, 'sas-attempts-exhausted');

  // even the correct SAS is refused once the ceremony is dead
  assert.equal(pair.host.submitSas(real).status, 'not-ready');
});

test('a correct SAS after two wrong ones still succeeds', () => {
  const pair = runToSas();
  const real = pair.controller.sas as string;
  const wrong = real === '000000' ? '000001' : '000000';
  pair.host.submitSas(wrong);
  pair.host.submitSas(wrong);
  finishWithSas(pair, real);
  assert.equal(pair.host.state, 'done');
});

test('malformed SAS input is reported as invalid and does not use up an attempt; spaces are ignored', () => {
  const pair = runToSas();
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x', '١٢٣٤٥٦']) {
    assert.deepEqual(pair.host.submitSas(bad), { status: 'invalid' }, JSON.stringify(bad));
  }
  assert.equal(pair.host.attemptsLeft, 3);
  const real = pair.controller.sas as string;
  finishWithSas(pair, `${real.slice(0, 3)} ${real.slice(3)}`);
  assert.equal(pair.host.state, 'done');
});

test('key confirmation is checked in both directions', () => {
  const hostForged = runToSas();
  const outcome = hostForged.host.submitSas(hostForged.controller.sas as string);
  assert.equal(outcome.status, 'accepted');
  const mac = outcome.status === 'accepted' ? Buffer.from(outcome.frames[0]) : Buffer.alloc(0);
  mac[mac.length - 1] ^= 0x01; // a Host confirmation with one bit flipped
  assert.deepEqual(hostForged.controller.receive(mac).map((frame) => pairFrameType(frame)), [PAIR_FRAME_TYPE.abort]);
  assert.equal(hostForged.controller.state, 'failed');
  assert.equal(hostForged.controller.failure, 'key-confirmation-failed');

  const controllerForged = runToSas();
  const accepted = controllerForged.host.submitSas(controllerForged.controller.sas as string);
  const [confirmation] = controllerForged.controller.receive(accepted.status === 'accepted' ? accepted.frames[0] : Buffer.alloc(0));
  const tampered = Buffer.from(confirmation);
  tampered[tampered.length - 1] ^= 0x80;
  const reply = controllerForged.host.receive(tampered);
  assert.deepEqual(reply.map((frame) => pairFrameType(frame)), [PAIR_FRAME_TYPE.abort]);
  assert.equal(controllerForged.host.state, 'failed');
  assert.equal(controllerForged.host.failure, 'key-confirmation-failed');
  assert.equal(controllerForged.host.takeResult(), null, 'no key is released without a valid confirmation');
});

test('device names: sanitizing keeps only [A-Za-z0-9 ._-], at most 32 characters, never empty', () => {
  assert.equal(sanitizeDeviceName('My Laptop 2.0_a-b'), 'My Laptop 2.0_a-b');
  assert.equal(sanitizeDeviceName("Sơn's <MacBook>/Pro"), 'Sns MacBookPro');
  assert.equal(sanitizeDeviceName('x'.repeat(100)), 'x'.repeat(32));
  assert.equal(sanitizeDeviceName('   padded   '), 'padded');
  assert.equal(sanitizeDeviceName('<<<>>>'), 'device');
  assert.equal(sanitizeDeviceName(''), 'device');
  assert.equal(sanitizeDeviceName(undefined as unknown as string), 'device');
  for (let i = 0; i < 200; i++) {
    const noisy = String.fromCharCode(...Array.from({ length: 80 }, (_, j) => (i * 7919 + j * 104729) % 0x3000));
    assert.ok(isValidDeviceName(sanitizeDeviceName(noisy)), JSON.stringify(sanitizeDeviceName(noisy)));
  }
  assert.ok(isValidDeviceName('a'));
  assert.ok(!isValidDeviceName(''));
  assert.ok(!isValidDeviceName('x'.repeat(33)));
  assert.ok(!isValidDeviceName('bad<name>'));
});

test('a long or odd local device name is sanitized before it is sent', () => {
  const host = createHostPairingCeremony({ hostName: 'Host' });
  const controller = createControllerPairingCeremony({ deviceName: `${'L'.repeat(60)}<script>` });
  pumpFrames(host, controller, [controller.start()]);
  assert.equal(host.controllerName, 'L'.repeat(32));
});

test('explicit abort (code lifetime, rejection) marks the ceremony failed and emits an abort frame', () => {
  const pair = runToSas();
  const frames = pair.host.abort('cancelled');
  assert.equal(frames.length, 1);
  assert.equal(pair.host.state, 'failed');
  assert.equal(pair.host.failure, 'cancelled');
  assert.deepEqual(pair.host.abort('expired'), [], 'a finished ceremony does not abort twice');
  pair.controller.receive(frames[0]);
  assert.equal(pair.controller.failure, 'cancelled');

  const expired = runToSas();
  assert.equal(decodePairAbort(expired.host.abort('expired')[0]), 'expired');
});

test('a finished ceremony zeroes the pairing key it derived, not just the copy it hands out (both roles)', (context) => {
  // Snapshot (hex) of every buffer that is about to be zeroed with fill(0).
  const zeroed: string[] = [];
  const realFill = Buffer.prototype.fill;
  context.mock.method(Buffer.prototype, 'fill', function (this: Buffer, ...args: Parameters<typeof realFill>) {
    if (args[0] === 0) zeroed.push(this.toString('hex'));
    return Reflect.apply(realFill, this, args);
  });
  const pair = runToSas();
  finishWithSas(pair, pair.controller.sas as string);
  const hostResult = pair.host.takeResult();
  const controllerResult = pair.controller.takeResult();
  assert.ok(hostResult && controllerResult);
  const kHex = hostResult.k.toString('hex');
  assert.equal(kHex, controllerResult.k.toString('hex'));
  // The returned copies are untouched, so every snapshot equal to K is an internal buffer: one per role.
  assert.ok(zeroed.filter((entry) => entry === kHex).length >= 2, 'material.k of the Host and of the Controller were wiped');
});
