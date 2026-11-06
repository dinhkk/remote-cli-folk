import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createControllerPairingCeremony, createHostPairingCeremony } from '../../pairing/pairing-ceremony.js';
import {
  PAIR_FRAME_TYPE,
  computeCommitment,
  decodePairAbort,
  decodePairHostKey,
  decodePairReveal,
  encodePairAbort,
  encodePairConfirm,
  encodePairHello,
  encodePairHostKey,
  encodePairNonce,
  encodePairReveal,
  pairFrameType,
} from '../../pairing/pairing-frames.js';

const publicKey = (): Buffer => {
  const der = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
};
const random = (length: number): Buffer => crypto.randomBytes(length);
const types = (frames: Buffer[]): Array<number | null> => frames.map((frame) => pairFrameType(frame));

const hostAfterHello = () => {
  const host = createHostPairingCeremony({ hostName: 'Office PC' });
  const pkC = publicKey();
  const out = host.receive(encodePairHello(pkC, 'My Laptop'));
  return { host, pkC, hostKey: decodePairHostKey(out[0]) };
};

const assertHostRejects = (frame: Buffer | Uint8Array, prepare?: (host: ReturnType<typeof createHostPairingCeremony>) => void) => {
  const host = createHostPairingCeremony({ hostName: 'Office PC' });
  prepare?.(host);
  const out = host.receive(frame);
  assert.equal(host.state, 'failed');
  assert.equal(host.failure, 'protocol-violation');
  assert.deepEqual(types(out), [PAIR_FRAME_TYPE.abort], 'the violation is answered with exactly one abort');
  assert.equal(host.takeResult(), null);
  return host;
};

test('Host: Nc before any hello (Controller sent a nonce without the key exchange) aborts', () => {
  assertHostRejects(encodePairNonce(random(16)));
});

test('Host: a repeated hello aborts, and so does a hello with a different pkC mid-ceremony', () => {
  const pkC = publicKey();
  assertHostRejects(encodePairHello(pkC, 'My Laptop'), (host) => host.receive(encodePairHello(pkC, 'My Laptop')));
  assertHostRejects(encodePairHello(publicKey(), 'My Laptop'), (host) => host.receive(encodePairHello(pkC, 'My Laptop')));
});

test('Host: the nonce must be exactly 16 bytes', () => {
  for (const length of [0, 1, 15, 17, 32]) {
    const frame = Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.nonce]), random(length)]);
    assertHostRejects(frame, (host) => host.receive(encodePairHello(publicKey(), 'My Laptop')));
  }
});

test('Host: a second Nc after the reveal, and any frame while waiting for the SAS, aborts', () => {
  const prepare = (host: ReturnType<typeof createHostPairingCeremony>) => {
    host.receive(encodePairHello(publicKey(), 'My Laptop'));
    host.receive(encodePairNonce(random(16)));
  };
  assertHostRejects(encodePairNonce(random(16)), prepare);
  assertHostRejects(encodePairHello(publicKey(), 'My Laptop'), prepare);
  assertHostRejects(encodePairConfirm('controller', random(32)), prepare); // confirmation before the Host accepted a SAS
});

test('Host: wrong-direction, unknown and empty frames abort in every state', () => {
  const bad = [
    encodePairHostKey(publicKey(), random(32), 'Evil'), // a host-key frame sent to a Host
    encodePairReveal(random(16)),
    encodePairConfirm('host', random(32)),
    Buffer.from([0x99, 1, 2, 3]),
    Buffer.alloc(0),
  ];
  for (const frame of bad) assertHostRejects(frame);
  for (const frame of bad) assertHostRejects(frame, (host) => host.receive(encodePairHello(publicKey(), 'My Laptop')));
});

test('Host: malformed hello frames abort (length, invalid key, bad names)', () => {
  const pk = publicKey();
  const named = (name: Buffer, declared = name.length) =>
    Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.hello]), pk, Buffer.from([declared]), name]);

  assertHostRejects(Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.hello]), pk])); // no name length byte
  assertHostRejects(Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.hello]), pk.subarray(0, 31), Buffer.from([1, 65])]));
  assertHostRejects(named(Buffer.from('abc'), 5)); // declared length beyond the frame
  assertHostRejects(named(Buffer.from('abc'), 2)); // declared length shorter than the frame
  assertHostRejects(named(Buffer.alloc(33, 0x41))); // 33 characters
  assertHostRejects(named(Buffer.from('bad<name>')));
  assertHostRejects(named(Buffer.from('Sơn', 'utf8'))); // outside [A-Za-z0-9 ._-]
  assertHostRejects(named(Buffer.alloc(0))); // empty name
  assertHostRejects(encodePairHello(Buffer.alloc(32), 'My Laptop')); // all-zero (low-order) public key
});

test('Host: a 32-character name of allowed characters is accepted', () => {
  const host = createHostPairingCeremony({ hostName: 'Office PC' });
  const out = host.receive(encodePairHello(publicKey(), 'A'.repeat(16) + '._- 09' + 'z'.repeat(10)));
  assert.equal(host.state, 'exchanging');
  assert.deepEqual(types(out), [PAIR_FRAME_TYPE.hostKey]);
});

test('Host: Nh stays hidden until Nc arrives, and is then revealed with exactly 16 bytes matching the commitment', () => {
  const { host, pkC, hostKey } = hostAfterHello();
  assert.ok(hostKey, 'the first answer carries pkH and the commitment');
  assert.equal(host.state, 'exchanging');
  assert.equal(host.controllerName, 'My Laptop');
  assert.equal(hostKey.hostName, 'Office PC');

  const out = host.receive(encodePairNonce(random(16)));
  assert.deepEqual(types(out), [PAIR_FRAME_TYPE.reveal]);
  const nh = decodePairReveal(out[0]);
  assert.ok(nh);
  assert.equal(nh.length, 16);
  assert.ok(computeCommitment(nh, hostKey.publicKey, pkC).equals(hostKey.commitment));
  assert.equal(host.state, 'awaiting-sas');
});

test('Host: an abort from the Controller ends the ceremony without a reply', () => {
  const { host } = hostAfterHello();
  assert.deepEqual(host.receive(encodePairAbort('cancelled')), []);
  assert.equal(host.state, 'failed');
  assert.equal(host.failure, 'peer-aborted');
});

test('Host: the Controller leaving after the hello fails the pairing; before the hello it is ignored', () => {
  const idle = createHostPairingCeremony({ hostName: 'Office PC' });
  assert.deepEqual(idle.peerLeft(), []);
  assert.equal(idle.state, 'waiting-controller');

  const { host } = hostAfterHello();
  host.peerLeft();
  assert.equal(host.state, 'failed');
  assert.equal(host.failure, 'peer-changed');
});

test('Host: once failed, every further frame is ignored without throwing', () => {
  const host = assertHostRejects(encodePairNonce(random(16)));
  assert.deepEqual(host.receive(encodePairHello(publicKey(), 'My Laptop')), []);
  assert.deepEqual(host.submitSas('123456'), { status: 'not-ready' });
  assert.equal(host.state, 'failed');
});

// ---------------------------------------------------------------------------------------------
// Controller side
// ---------------------------------------------------------------------------------------------

const assertControllerRejects = (frame: Buffer | Uint8Array, prepare?: (c: ReturnType<typeof createControllerPairingCeremony>) => void, failure = 'protocol-violation') => {
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  if (prepare) prepare(controller); // the preparation starts the controller itself
  else controller.start();
  const out = controller.receive(frame);
  assert.equal(controller.state, 'failed');
  assert.equal(controller.failure, failure);
  assert.equal(controller.sas, null, 'a failed ceremony never shows a SAS');
  assert.deepEqual(types(out), [PAIR_FRAME_TYPE.abort]);
  return controller;
};

/** Drives a real Host far enough to produce a valid host-key frame for this controller's hello. */
const validHostKeyFor = (controller: ReturnType<typeof createControllerPairingCeremony>) => {
  const host = createHostPairingCeremony({ hostName: 'Office PC' });
  const hello = controller.start();
  return { host, hello, hostKey: host.receive(hello)[0] };
};

test('Controller: it sends Nc only after it has the Host commitment, and only once', () => {
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  const { hostKey } = validHostKeyFor(controller);
  assert.equal(controller.state, 'awaiting-host-key');
  const out = controller.receive(hostKey);
  assert.deepEqual(types(out), [PAIR_FRAME_TYPE.nonce]);
  assert.equal(controller.state, 'awaiting-reveal');
  assert.throws(() => controller.start(), /already started/);
});

test('Controller: Nh before the commitment, a repeated host key, and out-of-order confirmations abort', () => {
  assertControllerRejects(encodePairReveal(random(16)));
  assertControllerRejects(encodePairConfirm('host', random(32)));
  assertControllerRejects(encodePairHello(publicKey(), 'Evil'));
  assertControllerRejects(Buffer.from([0x99]));
  assertControllerRejects(Buffer.alloc(0));

  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  const { hostKey } = validHostKeyFor(controller);
  controller.receive(hostKey);
  assert.deepEqual(types(controller.receive(hostKey)), [PAIR_FRAME_TYPE.abort], 'second host key');
  assert.equal(controller.failure, 'protocol-violation');

  const early = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  early.receive(validHostKeyFor(early).hostKey);
  assert.deepEqual(types(early.receive(encodePairConfirm('host', random(32)))), [PAIR_FRAME_TYPE.abort], 'confirmation before Nh');
  assert.equal(early.failure, 'protocol-violation');
});

test('Controller: malformed host-key frames abort (length, invalid key, bad name)', () => {
  const pk = publicKey();
  const frame = (key: Buffer, name: Buffer, declared = name.length) =>
    Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.hostKey]), key, random(32), Buffer.from([declared]), name]);
  assertControllerRejects(frame(pk, Buffer.from('Host')).subarray(0, 60));
  assertControllerRejects(frame(Buffer.alloc(32), Buffer.from('Host')));
  assertControllerRejects(frame(pk, Buffer.from('Ho<st')));
  assertControllerRejects(frame(pk, Buffer.alloc(33, 0x41)));
  assertControllerRejects(frame(pk, Buffer.from('Host'), 9));
});

test('Controller: Nh must be exactly 16 bytes', () => {
  for (const length of [0, 15, 17]) {
    const frame = Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.reveal]), random(length)]);
    assertControllerRejects(frame, (controller) => {
      const { hostKey } = validHostKeyFor(controller);
      controller.receive(hostKey);
    });
  }
});

test('Controller: a Host that reveals a different Nh than it committed to is caught and no SAS is shown', () => {
  // A cheating Host picks Nh after seeing Nc (to steer the SAS): the commitment no longer matches.
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  controller.receive(validHostKeyFor(controller).hostKey);
  const out = controller.receive(encodePairReveal(random(16)));
  assert.deepEqual(types(out), [PAIR_FRAME_TYPE.abort]);
  assert.equal(controller.state, 'failed');
  assert.equal(controller.failure, 'commitment-mismatch');
  assert.equal(controller.sas, null);
  assert.equal(decodePairAbort(out[0]), 'peer-aborted', 'the peer only learns that the other side aborted');
});

test('Controller: a Host key swapped after the commitment is caught as well', () => {
  const controller = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  const { host, hostKey } = validHostKeyFor(controller);
  const decoded = decodePairHostKey(hostKey);
  assert.ok(decoded);
  const [nonce] = controller.receive(encodePairHostKey(publicKey(), decoded.commitment, 'Office PC')); // other pkH, old C
  const reveal = host.receive(nonce)[0];
  controller.receive(reveal);
  assert.equal(controller.failure, 'commitment-mismatch');
  assert.equal(controller.sas, null);
});

test('Controller: an abort from the Host maps to its reason; the Host leaving fails the join', () => {
  const expired = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  expired.start();
  assert.deepEqual(expired.receive(encodePairAbort('expired')), []);
  assert.equal(expired.failure, 'expired');

  const protocol = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  protocol.start();
  protocol.receive(encodePairAbort('protocol-violation'));
  assert.equal(protocol.failure, 'peer-aborted');

  const gone = createControllerPairingCeremony({ deviceName: 'My Laptop' });
  gone.peerLeft();
  assert.equal(gone.state, 'idle', 'nothing was started, nothing to fail');
  gone.start();
  gone.peerLeft();
  assert.equal(gone.state, 'failed');
  assert.equal(gone.failure, 'peer-changed');
  assert.equal(gone.takeResult(), null);
});

test('Controller: once failed, further frames are ignored', () => {
  const controller = assertControllerRejects(encodePairReveal(random(16)));
  assert.deepEqual(controller.receive(encodePairReveal(random(16))), []);
  assert.deepEqual(controller.abort('cancelled'), []);
});
