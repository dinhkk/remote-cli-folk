/**
 * Controller side of pairing: enter the code, show the SAS, store the pairing.
 *
 * `join` derives the pair room from the code and connects as Controller. When the Host is present
 * the ceremony starts; the Controller shows the six digits (`showing-sas`) for the user to type at
 * the Host. The pairing is stored only after the Host's key confirmation verified, and before the
 * Controller's own confirmation is sent, so a storage failure never leaves the Host holding a
 * pairing the Controller does not. Relay close codes become stable failure reasons.
 */

import crypto from 'node:crypto';

import type {
  RemoteClock,
  RemoteControllerPairingCeremony,
  RemoteControllerPairingStatus,
  RemotePairChannel,
  RemotePairConnector,
  RemotePairingFailure,
  RemotePairingStore,
} from '@/shared/types.js';

import { systemClock } from './pairing-clock.js';
import { createControllerPairingCeremony } from './pairing-ceremony.js';
import { resolvePairCode } from './pairing-code.js';
import { PAIRING_CODE_TTL_MS } from './pairing-constants.js';
import { describeFailureCause } from './pairing-failure-cause.js';
import { encodePairAbort } from './pairing-frames.js';

const FINISHED_JOIN_RETENTION_MS = 60 * 60_000;

/** What a relay close code means for a Controller that is trying to pair. */
const failureForRelayClose = (code: number): RemotePairingFailure => {
  switch (code) {
    case 4404:
      return 'code-not-found';
    case 4410:
      return 'code-used-or-expired';
    case 4429:
      return 'relay-locked';
    case 4401:
      return 'relay-rejected';
    case 4409:
      return 'peer-changed';
    default:
      return 'relay-unavailable';
  }
};

type ControllerPairingServiceOptions = {
  connect: RemotePairConnector;
  store: RemotePairingStore;
  /** Relay URL recorded with the new pairing. */
  getRelayUrl: () => string;
  clock?: RemoteClock;
};

type Join = {
  id: string;
  expiresAt: number;
  ceremony: RemoteControllerPairingCeremony;
  channel: RemotePairChannel | null;
  channelClosed: boolean;
  helloSent: boolean;
  cancelExpiry: () => void;
  finished: boolean;
  failure: RemotePairingFailure | null;
  /** Non-secret label of the error behind a `storage-error`. */
  failureCause: string | null;
  peerId: string | null;
  hostName: string | null;
  finishedAt: number;
};

/**
 * Creates the Controller pairing service.
 * Consumed by: the Remote management API (phase 08).
 */
export const createControllerPairingService = ({ connect, store, getRelayUrl, clock = systemClock }: ControllerPairingServiceOptions) => {
  const joins = new Map<string, Join>();

  const sendFrames = (join: Join, frames: Buffer[]): void => {
    if (join.channelClosed) return;
    for (const frame of frames) join.channel?.sendFrame(frame);
  };

  const finish = (join: Join, failure: RemotePairingFailure | null): void => {
    if (join.finished) return;
    join.finished = true;
    join.failure = failure;
    join.finishedAt = clock.now();
    join.hostName = join.ceremony.hostName;
    join.cancelExpiry();
    if (!join.channelClosed) {
      join.channelClosed = true;
      join.channel?.sendDestroy();
      join.channel?.close();
    }
  };

  const expire = (join: Join): void => {
    if (join.finished) return;
    sendFrames(join, join.ceremony.abort('expired'));
    finish(join, 'expired');
  };

  /** Handles one relay frame; persists the pairing before the confirmation leaves the process. */
  const onFrame = (join: Join, frame: Uint8Array): void => {
    if (join.finished) return;
    const replies = join.ceremony.receive(frame);
    const { state, failure } = join.ceremony;
    if (state === 'failed') {
      sendFrames(join, replies);
      return finish(join, failure);
    }
    if (state !== 'done') return sendFrames(join, replies);

    const result = join.ceremony.takeResult();
    try {
      if (!result) throw new Error('missing ceremony result');
      join.peerId = store.insertPairing({ role: 'controller', peerName: result.peerName, k: result.k, relayUrl: getRelayUrl() }).id;
    } catch (error) {
      join.failureCause = describeFailureCause(error);
      sendFrames(join, [encodePairAbort('cancelled')]);
      return finish(join, 'storage-error');
    } finally {
      result?.k.fill(0);
    }
    sendFrames(join, replies);
    finish(join, null);
  };

  const cancel = (joinId: string): void => {
    const join = joins.get(joinId);
    if (!join || join.finished) return;
    sendFrames(join, join.ceremony.abort('cancelled'));
    finish(join, 'cancelled');
  };

  return {
    /**
     * Starts joining with the code the Host displays. Throws `InvalidPairCodeError` for text that
     * is not a code (before any network use). Progress is read with `getStatus`.
     */
    join({ code, deviceName }: { code: string; deviceName: string }): { joinId: string } {
      const { pairRoomId, pairToken } = resolvePairCode(code);
      for (const [id, join] of joins) {
        if (join.finished && clock.now() - join.finishedAt > FINISHED_JOIN_RETENTION_MS) joins.delete(id);
      }

      const join: Join = {
        id: crypto.randomUUID(),
        expiresAt: clock.now() + PAIRING_CODE_TTL_MS,
        ceremony: createControllerPairingCeremony({ deviceName }),
        channel: null,
        channelClosed: false,
        helloSent: false,
        cancelExpiry: () => undefined,
        finished: false,
        failure: null,
        failureCause: null,
        peerId: null,
        hostName: null,
        finishedAt: 0,
      };
      joins.set(join.id, join);
      join.cancelExpiry = clock.setTimer(() => expire(join), PAIRING_CODE_TTL_MS);
      join.channel = connect(
        { roomId: pairRoomId, pairToken, role: 'controller' },
        {
          onReady: () => undefined,
          onPeer: (up) => {
            if (join.finished) return;
            if (up) {
              // The Host is in the room: start the ceremony (once).
              if (join.helloSent) return;
              join.helloSent = true;
              sendFrames(join, [join.ceremony.start()]);
              return;
            }
            join.ceremony.peerLeft();
            if (join.ceremony.state === 'failed') finish(join, join.ceremony.failure);
          },
          onFrame: (frame) => onFrame(join, frame),
          onClose: (closeCode) => {
            join.channelClosed = true;
            finish(join, failureForRelayClose(closeCode));
          },
        },
      );
      return { joinId: join.id };
    },

    /** Current view of a join, or null for an unknown id. `sas` is present only while it must be shown. */
    getStatus(joinId: string): RemoteControllerPairingStatus | null {
      const join = joins.get(joinId);
      if (!join) return null;
      if (!join.finished && clock.now() >= join.expiresAt) expire(join);
      if (join.finished) {
        if (join.peerId) return { state: 'done', hostName: join.hostName ?? undefined, peerId: join.peerId };
        return { state: 'failed', failure: join.failure ?? 'protocol-violation', hostName: join.hostName ?? undefined };
      }
      const { state, sas, hostName } = join.ceremony;
      if (state === 'showing-sas' && sas) return { state: 'showing-sas', sas, hostName: hostName ?? undefined };
      return { state: join.helloSent ? 'exchanging' : 'connecting' };
    },

    /** Operator diagnostics: a non-secret code for a `storage-error`, null otherwise (not part of the status JSON). */
    getFailureCause(joinId: string): string | null {
      return joins.get(joinId)?.failureCause ?? null;
    },

    cancel,
  };
};
