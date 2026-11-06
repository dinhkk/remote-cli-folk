import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createControllerPairingCeremony, createHostPairingCeremony } from '../../pairing/pairing-ceremony.js';
import {
  computeCommitment,
  computePairTranscript,
  decodePairHello,
  decodePairNonce,
  encodePairHostKey,
  encodePairReveal,
  sasFromTranscript,
} from '../../pairing/pairing-frames.js';
import { pumpFrames, runToSas } from '../support/ceremony-driver.js';
import { createSeededRandom } from '../support/seeded-random.js';

const publicKey = (): Buffer => {
  const der = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
};

// Each run below has a ~1e-6 chance per guess of a lucky match (a 6-digit SAS). The assertions allow
// at most one such match across the whole simulation (two would be a ~1e-5 event), so the tests
// are effectively deterministic while still failing loudly if the SAS ever stops depending on both sides' keys.

test('a man in the middle who runs two separate ceremonies leaves the two sides with different SAS values', () => {
  const runs = 200;
  let sameSas = 0;
  let hostAccepted = 0;
  for (let run = 0; run < runs; run++) {
    const realHost = createHostPairingCeremony({ hostName: 'Office PC' });
    const realController = createControllerPairingCeremony({ deviceName: 'My Laptop' });
    // Mallory plays Controller towards the Host and Host towards the Controller, each with its own keys.
    const towardsHost = createControllerPairingCeremony({ deviceName: 'My Laptop' });
    const towardsController = createHostPairingCeremony({ hostName: 'Office PC' });

    pumpFrames(realHost, towardsHost, [towardsHost.start()]);
    pumpFrames(towardsController, realController, [realController.start()]);
    assert.equal(realController.state, 'showing-sas');
    assert.equal(realHost.state, 'awaiting-sas');

    // The user reads the number on the real Controller and types it at the real Host.
    if (realController.sas === towardsHost.sas) sameSas++;
    if (realHost.submitSas(realController.sas as string).status === 'accepted') hostAccepted++;
  }
  assert.ok(sameSas <= 1, `SAS collided ${sameSas} times in ${runs} runs`);
  assert.ok(hostAccepted <= 1, `Host accepted a mismatched SAS ${hostAccepted} times`);
});

test('control: an honest Host reveal of the committed Nh is accepted and shows a SAS', () => {
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  const hello = decodePairHello(controller.start());
  assert.ok(hello);
  const pkH = publicKey();
  const nh = crypto.randomBytes(16);
  const [nonceFrame] = controller.receive(encodePairHostKey(pkH, computeCommitment(nh, pkH, hello.publicKey), 'Office PC'));
  const nc = decodePairNonce(nonceFrame);
  assert.ok(nc);
  controller.receive(encodePairReveal(nh));
  assert.equal(controller.state, 'showing-sas');
  assert.equal(controller.sas, sasFromTranscript(computePairTranscript(hello.publicKey, pkH, nc, nh)));
});

test('a Host that grinds Nh after seeing Nc to steer the SAS cannot: the reveal contradicts its commitment', () => {
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  const hello = decodePairHello(controller.start());
  assert.ok(hello);
  const pkH = publicKey();
  const committedNh = crypto.randomBytes(16);
  const [nonceFrame] = controller.receive(encodePairHostKey(pkH, computeCommitment(committedNh, pkH, hello.publicKey), 'Evil'));
  const nc = decodePairNonce(nonceFrame) as Buffer;

  // The attacker now knows Nc and searches for an Nh whose SAS ends in 00 (about 1 in 100).
  let ground: Buffer | null = null;
  for (let attempt = 0; attempt < 20_000 && !ground; attempt++) {
    const candidate = crypto.randomBytes(16);
    if (sasFromTranscript(computePairTranscript(hello.publicKey, pkH, nc, candidate)).endsWith('00')) ground = candidate;
  }
  assert.ok(ground, 'the search itself is cheap, which is exactly why the commitment is needed');

  controller.receive(encodePairReveal(ground));
  assert.equal(controller.state, 'failed');
  assert.equal(controller.failure, 'commitment-mismatch');
  assert.equal(controller.sas, null, 'the ground SAS is never displayed');
});

/** Pearson chi-square statistic of `counts` against a uniform expectation. */
const chiSquare = (counts: number[], total: number): number => {
  const expected = total / counts.length;
  return counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
};

test('the SAS is uniform over 000000-999999: chi-square over last-3-digits buckets and over every digit position', () => {
  // Seeded, so the run is reproducible. Thresholds sit ~4.5 standard deviations above the mean of a perfectly
  // uniform source (df=999: mean 999, sd 44.7 -> limit 1200; df=9: limit 30, i.e. p < 0.001): a flaky pass is
  // ruled out by the seed and a source that favours some values (or digits) by even a few percent fails by far.
  // The 0.023% modulo bias of uint32 % 1e6 is deliberately NOT detectable here (it is bounded analytically: max 4295 / 2^32 per value).
  const random = createSeededRandom(0x5a5c0de);
  const samples = 300_000;
  const lastThree = new Array<number>(1000).fill(0);
  const digits = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
  for (let i = 0; i < samples; i++) {
    const transcript = computePairTranscript(random.bytes(32), random.bytes(32), random.bytes(16), random.bytes(16));
    const sas = sasFromTranscript(transcript);
    assert.match(sas, /^\d{6}$/);
    lastThree[Number(sas.slice(3))]++;
    for (let position = 0; position < 6; position++) digits[position][Number(sas[position])]++;
  }
  const bucketStatistic = chiSquare(lastThree, samples);
  assert.ok(bucketStatistic < 1200, `chi-square over 1000 buckets was ${bucketStatistic.toFixed(1)}`);
  digits.forEach((counts, position) => {
    const statistic = chiSquare(counts, samples);
    assert.ok(statistic < 30, `digit ${position}: chi-square ${statistic.toFixed(1)}`);
  });
  const leadingZeros = digits[0][0];
  assert.ok(Math.abs(leadingZeros / samples - 0.1) < 0.005, 'six digits including leading zeros are all used');
});

test('an attacker who knows the code and joins first still has to produce a SAS from the real Controller (1000 simulations)', () => {
  const runs = 1000;
  let successes = 0;
  let locked = 0;
  for (let run = 0; run < runs; run++) {
    // The attacker completes the key exchange with the Host (it knows the code)...
    const host = createHostPairingCeremony({ hostName: 'Office PC' });
    const attacker = createControllerPairingCeremony({ deviceName: 'My Laptop' });
    pumpFrames(host, attacker, [attacker.start()]);
    assert.equal(host.state, 'awaiting-sas');

    // ...but the Host user reads the SAS off the real Controller, a different session entirely.
    const real = runToSas();
    const typed = real.controller.sas as string;
    for (let attempt = 0; attempt < 3 && host.state === 'awaiting-sas'; attempt++) host.submitSas(typed);
    const finalState: string = host.state; // widened: the loop above changes it behind the compiler's back
    if (finalState === 'done' || finalState === 'confirming') successes++;
    if (finalState === 'failed' && host.failure === 'sas-attempts-exhausted') locked++;
  }
  assert.ok(successes <= 1, `${successes} attacker successes in ${runs} runs`);
  assert.ok(locked >= runs - 1, 'every other run ended in a lockout');
});
