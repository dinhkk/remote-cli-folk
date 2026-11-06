/**
 * Pairing ceremony state machines (contracts section 5, "Bat bien ceremony").
 *
 * Numeric-comparison pairing with a commitment, so a short human-checked number protects an
 * ECDH exchange that anyone who knows the (low-entropy) code can join:
 *
 *   1. Controller -> Host   HELLO(pkC, deviceName)
 *   2. Host -> Controller   HOST_KEY(pkH, C = HMAC(Nh, pkH||pkC), hostName)   Host commits to Nh
 *   3. Controller -> Host   NONCE(Nc)           only after it holds C
 *   4. Host -> Controller   REVEAL(Nh)          only after it holds Nc
 *   5. Controller checks C, both compute SAS = SHA256(pkC||pkH||Nc||Nh) -> 6 digits and
 *      K = HKDF(ECDH, salt = Nc||Nh, "pairing-key"); the Controller SHOWS the SAS
 *   6. The Host user TYPES the SAS; only then does the Host send HOST_CONFIRM, the Controller
 *      answers CONTROLLER_CONFIRM (HMAC under the K-derived macKey over the transcript)
 *
 * Nobody can steer the SAS: the Host fixed Nh before seeing Nc, the Controller fixed Nc before
 * seeing Nh. A man in the middle must run two separate exchanges, whose SAS values differ.
 *
 * Both machines are transport-free and strictly ordered: any frame that is malformed, repeated,
 * out of order, or arrives in the wrong state aborts the ceremony (answered with one ABORT frame)
 * and wipes its secrets. Frames after the end are ignored. The Host machine has no SAS accessor by
 * design: it only compares what the user types.
 */

import crypto from 'node:crypto';

import type {
  RemoteCeremonyResult,
  RemoteControllerCeremonyState,
  RemoteControllerPairingCeremony,
  RemoteHostCeremonyState,
  RemoteHostPairingCeremony,
  RemoteHostSasResult,
  RemotePairingFailure,
} from '@/shared/types.js';

import { computeSharedSecret, generateEphemeral } from '../crypto/handshake.js';
import { deriveLinkKeys, derivePairingKey } from '../crypto/key-derivation.js';

import {
  PAIR_FRAME_TYPE,
  computeCommitment,
  computeConfirmMac,
  computePairTranscript,
  decodePairAbort,
  decodePairConfirm,
  decodePairHello,
  decodePairHostKey,
  decodePairNonce,
  decodePairReveal,
  encodePairAbort,
  encodePairConfirm,
  encodePairHello,
  encodePairHostKey,
  encodePairNonce,
  encodePairReveal,
  pairFrameType,
  sanitizeDeviceName,
  sasFromTranscript,
} from './pairing-frames.js';

const NONCE_BYTES = 16;
const MAX_SAS_ATTEMPTS = 3;

type CeremonyOptions = {
  /** Byte source for nonces; injectable for reproducible simulations. Defaults to `crypto.randomBytes`. */
  randomBytes?: (length: number) => Buffer;
};

/** X25519 shared secret with the peer's raw public key, or null for an invalid/low-order key. */
const agree = (privateKey: crypto.KeyObject, peerPublicRaw: Buffer): Buffer | null => {
  try {
    return computeSharedSecret(crypto.diffieHellman, privateKey, peerPublicRaw);
  } catch {
    return null;
  }
};

const macEquals = (expected: Buffer, actual: Buffer): boolean =>
  expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

/** Everything both machines derive once the nonces are known. */
type DerivedMaterial = { k: Buffer; transcript: Buffer; sas: string; macKey: Buffer };

const derive = (ecdh: Buffer, pkC: Buffer, pkH: Buffer, nc: Buffer, nh: Buffer): DerivedMaterial => {
  const k = derivePairingKey(ecdh, nc, nh);
  const transcript = computePairTranscript(pkC, pkH, nc, nh);
  return { k, transcript, sas: sasFromTranscript(transcript), macKey: deriveLinkKeys(k).macKey };
};

// ---------------------------------------------------------------------------
// Host (verifier): commits first, reveals last, checks the typed SAS
// ---------------------------------------------------------------------------

/**
 * Creates the Host side of a ceremony. `hostName` is the (already valid) name shown to the
 * Controller. Consumed by: the Host pairing service.
 */
export const createHostPairingCeremony = ({ hostName, randomBytes = crypto.randomBytes }: CeremonyOptions & { hostName: string }): RemoteHostPairingCeremony => {
  let state: RemoteHostCeremonyState = 'waiting-controller';
  let failure: RemotePairingFailure | null = null;
  let controllerName: string | null = null;
  let attemptsLeft = MAX_SAS_ATTEMPTS;

  let privateKey: crypto.KeyObject | null = null;
  let publicKeyH: Buffer | null = null;
  let publicKeyC: Buffer | null = null;
  let nonceH: Buffer | null = null;
  let ecdh: Buffer | null = null;
  let material: DerivedMaterial | null = null;
  let result: RemoteCeremonyResult | null = null;

  const wipe = (): void => {
    nonceH?.fill(0);
    ecdh?.fill(0);
    material?.macKey.fill(0);
    material?.k.fill(0);
    material?.transcript.fill(0);
    privateKey = null;
    nonceH = null;
    ecdh = null;
    material = null;
  };

  const fail = (reason: RemotePairingFailure, notifyPeer = true): Buffer[] => {
    if (state === 'failed' || state === 'done') return [];
    state = 'failed';
    failure = reason;
    wipe();
    return notifyPeer ? [encodePairAbort(reason)] : [];
  };

  const onHello = (frame: Uint8Array): Buffer[] => {
    const hello = decodePairHello(frame);
    if (!hello) return fail('protocol-violation');
    const ephemeral = generateEphemeral();
    const secret = agree(ephemeral.privateKey, hello.publicKey);
    if (!secret) return fail('protocol-violation');
    privateKey = ephemeral.privateKey;
    publicKeyH = ephemeral.publicRaw;
    publicKeyC = hello.publicKey;
    ecdh = secret;
    nonceH = randomBytes(NONCE_BYTES);
    controllerName = hello.deviceName;
    state = 'exchanging';
    return [encodePairHostKey(publicKeyH, computeCommitment(nonceH, publicKeyH, publicKeyC), hostName)];
  };

  const onNonce = (frame: Uint8Array): Buffer[] => {
    const nonceC = decodePairNonce(frame);
    if (!nonceC || !ecdh || !nonceH || !publicKeyC || !publicKeyH) return fail('protocol-violation');
    material = derive(ecdh, publicKeyC, publicKeyH, nonceC, nonceH);
    state = 'awaiting-sas';
    return [encodePairReveal(nonceH)];
  };

  const onControllerConfirm = (frame: Uint8Array): Buffer[] => {
    const mac = decodePairConfirm(frame, 'controller');
    if (!mac || !material || !controllerName) return fail('protocol-violation');
    if (!macEquals(computeConfirmMac('controller', material.macKey, material.transcript), mac)) return fail('key-confirmation-failed');
    result = { k: Buffer.from(material.k), peerName: controllerName };
    wipe();
    state = 'done';
    return [];
  };

  return {
    get state() {
      return state;
    },
    get controllerName() {
      return controllerName;
    },
    get attemptsLeft() {
      return attemptsLeft;
    },
    get failure() {
      return failure;
    },

    receive(frame) {
      if (state === 'failed' || state === 'done') return [];
      const type = pairFrameType(frame);
      if (type === PAIR_FRAME_TYPE.abort) return decodePairAbort(frame) ? fail('peer-aborted', false) : fail('protocol-violation');
      if (state === 'waiting-controller' && type === PAIR_FRAME_TYPE.hello) return onHello(frame);
      if (state === 'exchanging' && type === PAIR_FRAME_TYPE.nonce) return onNonce(frame);
      if (state === 'confirming' && type === PAIR_FRAME_TYPE.controllerConfirm) return onControllerConfirm(frame);
      // Wrong type for this state, a repeat, or a frame while the user is still typing: out of order.
      return fail('protocol-violation');
    },

    peerLeft() {
      // Before the hello nobody is committed to this ceremony yet; afterwards any change of the
      // opposite side could mean a different party, so the one-time code is spent.
      if (state === 'exchanging' || state === 'awaiting-sas' || state === 'confirming') return fail('peer-changed', false);
      return [];
    },

    submitSas(input) {
      if (state !== 'awaiting-sas' || !material) return { status: 'not-ready' };
      const typed = typeof input === 'string' ? input.replace(/\s+/g, '') : '';
      if (!/^[0-9]{6}$/.test(typed)) return { status: 'invalid' };
      if (macEquals(Buffer.from(material.sas), Buffer.from(typed))) {
        const confirmation = computeConfirmMac('host', material.macKey, material.transcript);
        state = 'confirming';
        return { status: 'accepted', frames: [encodePairConfirm('host', confirmation)] };
      }
      attemptsLeft -= 1;
      const frames = attemptsLeft === 0 ? fail('sas-attempts-exhausted') : [];
      return { status: 'rejected', attemptsLeft, frames } satisfies RemoteHostSasResult;
    },

    abort(reason) {
      return fail(reason);
    },

    takeResult() {
      const taken = result;
      result = null;
      return taken;
    },
  };
};

// ---------------------------------------------------------------------------
// Controller (initiator): sends Nc only after the commitment, shows the SAS
// ---------------------------------------------------------------------------

/**
 * Creates the Controller side. `deviceName` is sanitized before it is sent.
 * Consumed by: the Controller pairing service.
 */
export const createControllerPairingCeremony = ({ deviceName, randomBytes = crypto.randomBytes }: CeremonyOptions & { deviceName: string }): RemoteControllerPairingCeremony => {
  const name = sanitizeDeviceName(deviceName);
  let state: RemoteControllerCeremonyState = 'idle';
  let failure: RemotePairingFailure | null = null;
  let hostName: string | null = null;

  let privateKey: crypto.KeyObject | null = null;
  let publicKeyC: Buffer | null = null;
  let publicKeyH: Buffer | null = null;
  let commitment: Buffer | null = null;
  let nonceC: Buffer | null = null;
  let ecdh: Buffer | null = null;
  let material: DerivedMaterial | null = null;
  let result: RemoteCeremonyResult | null = null;

  const wipe = (): void => {
    nonceC?.fill(0);
    ecdh?.fill(0);
    material?.macKey.fill(0);
    material?.k.fill(0);
    material?.transcript.fill(0);
    privateKey = null;
    nonceC = null;
    ecdh = null;
    material = null;
  };

  const fail = (reason: RemotePairingFailure, notifyPeer = true): Buffer[] => {
    if (state === 'failed' || state === 'done') return [];
    const started = state !== 'idle';
    state = 'failed';
    failure = reason;
    wipe();
    return notifyPeer && started ? [encodePairAbort(reason)] : [];
  };

  const onHostKey = (frame: Uint8Array): Buffer[] => {
    const hostKey = decodePairHostKey(frame);
    if (!hostKey || !privateKey) return fail('protocol-violation');
    const secret = agree(privateKey, hostKey.publicKey);
    if (!secret) return fail('protocol-violation');
    publicKeyH = hostKey.publicKey;
    commitment = hostKey.commitment;
    hostName = hostKey.hostName;
    ecdh = secret;
    // Only now, holding the Host's commitment, does the Controller pick and send Nc.
    nonceC = randomBytes(NONCE_BYTES);
    state = 'awaiting-reveal';
    return [encodePairNonce(nonceC)];
  };

  const onReveal = (frame: Uint8Array): Buffer[] => {
    const nonceH = decodePairReveal(frame);
    if (!nonceH || !ecdh || !nonceC || !publicKeyC || !publicKeyH || !commitment) return fail('protocol-violation');
    if (!macEquals(computeCommitment(nonceH, publicKeyH, publicKeyC), commitment)) return fail('commitment-mismatch');
    material = derive(ecdh, publicKeyC, publicKeyH, nonceC, nonceH);
    state = 'showing-sas';
    return [];
  };

  const onHostConfirm = (frame: Uint8Array): Buffer[] => {
    const mac = decodePairConfirm(frame, 'host');
    if (!mac || !material || !hostName) return fail('protocol-violation');
    if (!macEquals(computeConfirmMac('host', material.macKey, material.transcript), mac)) return fail('key-confirmation-failed');
    const reply = encodePairConfirm('controller', computeConfirmMac('controller', material.macKey, material.transcript));
    result = { k: Buffer.from(material.k), peerName: hostName };
    wipe();
    state = 'done';
    return [reply];
  };

  return {
    get state() {
      return state;
    },
    get sas() {
      return state === 'showing-sas' && material ? material.sas : null;
    },
    get hostName() {
      return hostName;
    },
    get failure() {
      return failure;
    },

    start() {
      if (state !== 'idle') throw new Error('Ceremony already started.');
      const ephemeral = generateEphemeral();
      privateKey = ephemeral.privateKey;
      publicKeyC = ephemeral.publicRaw;
      state = 'awaiting-host-key';
      return encodePairHello(publicKeyC, name);
    },

    receive(frame) {
      if (state === 'idle' || state === 'failed' || state === 'done') return [];
      const type = pairFrameType(frame);
      if (type === PAIR_FRAME_TYPE.abort) {
        const reason = decodePairAbort(frame);
        return reason ? fail(reason, false) : fail('protocol-violation');
      }
      if (state === 'awaiting-host-key' && type === PAIR_FRAME_TYPE.hostKey) return onHostKey(frame);
      if (state === 'awaiting-reveal' && type === PAIR_FRAME_TYPE.reveal) return onReveal(frame);
      if (state === 'showing-sas' && type === PAIR_FRAME_TYPE.hostConfirm) return onHostConfirm(frame);
      return fail('protocol-violation');
    },

    peerLeft() {
      if (state === 'awaiting-host-key' || state === 'awaiting-reveal' || state === 'showing-sas') return fail('peer-changed', false);
      return [];
    },

    abort(reason) {
      return fail(reason);
    },

    takeResult() {
      const taken = result;
      result = null;
      return taken;
    },
  };
};
