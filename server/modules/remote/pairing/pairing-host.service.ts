/**
 * Host side of pairing: code lifetime, SAS lockout, pairing limit, and the relay pair room.
 *
 * One pairing is active at a time. `start()` makes a code and opens the relay pair room as Host;
 * the ceremony state machine does the cryptography; this service owns what surrounds it:
 *   - the code dies after 5 minutes or after it was used (the room is torn down either way);
 *   - three wrong SAS entries lock the Host for 15 minutes, and nothing else does: whoever holds a
 *     code can join and sit idle, so expiry, a rejection by the user and a relay outage must not
 *     be lockable by a stranger. The lock is persisted (`remote.pair_lock_until`), so a restart
 *     cannot clear it;
 *   - `start()` while a Controller has already joined returns the running pairing (a double click
 *     must not cancel a ceremony in progress);
 *   - at most `maxPairings` (default 8) active Host pairings (FR-7);
 *   - the Host never reports the SAS; it only checks what the user typed.
 * On success the pairing key is sealed into the store. Nothing here logs codes, SAS values or keys.
 */

import crypto from 'node:crypto';
import os from 'node:os';

import type {
  RemoteClock,
  RemoteHostPairingCeremony,
  RemoteHostPairingState,
  RemoteHostPairingStatus,
  RemotePairChannel,
  RemotePairConnector,
  RemotePairingFailure,
  RemotePairingStore,
} from '@/shared/types.js';

import { createConfigPairLockStore, type PairLockStore } from './pair-lock-store.js';
import { systemClock } from './pairing-clock.js';
import { createHostPairingCeremony } from './pairing-ceremony.js';
import { formatPairCode, generatePairCode, resolvePairCode } from './pairing-code.js';
import { PAIRING_CODE_TTL_MS } from './pairing-constants.js';
import { describeFailureCause } from './pairing-failure-cause.js';
import { sanitizeDeviceName } from './pairing-frames.js';

const PAIRING_LOCK_MS = 15 * 60_000;
const DEFAULT_MAX_PAIRINGS = 8;
const FINISHED_SESSION_RETENTION_MS = 60 * 60_000;

/** What a relay close code means for a Host whose pair room ended. 4410: the code died (expired or used). */
const failureForRelayClose = (code: number): RemotePairingFailure => {
  switch (code) {
    case 4410:
      return 'expired';
    case 4401:
      return 'relay-rejected';
    case 4429:
      return 'relay-locked';
    default:
      return 'relay-unavailable';
  }
};

type PairingErrorCode = 'PAIRING_LOCKED' | 'PAIRING_LIMIT' | 'PAIRING_NOT_FOUND' | 'PAIRING_NOT_READY' | 'INVALID_SAS';

/** Refused request; `code` is stable for the management API (phase 08) to map to an HTTP answer. */
export class PairingError extends Error {
  readonly code: PairingErrorCode;
  /** Epoch ms when the Host may pair again; present for `PAIRING_LOCKED`. */
  readonly lockedUntil?: number;

  constructor(code: PairingErrorCode, message: string, lockedUntil?: number) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.lockedUntil = lockedUntil;
  }
}

type HostPairingServiceOptions = {
  connect: RemotePairConnector;
  store: RemotePairingStore;
  /** Relay URL recorded with each new pairing. */
  getRelayUrl: () => string;
  /** Name shown to Controllers (unverified on their side); defaults to the machine's host name. */
  hostName?: string;
  clock?: RemoteClock;
  maxPairings?: number;
  /** Where the 15-minute lock is persisted; defaults to the throwing `remote.*` config repository. */
  lockStore?: PairLockStore;
};

type Session = {
  id: string;
  /** Formatted code, kept in memory so a repeated `start()` can show it again. */
  displayCode: string;
  expiresAt: number;
  ceremony: RemoteHostPairingCeremony;
  channel: RemotePairChannel | null;
  channelClosed: boolean;
  cancelExpiry: () => void;
  finished: boolean;
  failure: RemotePairingFailure | null;
  /** Non-secret label of the error behind a `storage-error`. */
  failureCause: string | null;
  pairingId: string | null;
  finishedAt: number;
};

/**
 * Creates the Host pairing service.
 * Consumed by: the Remote management API (phase 08).
 */
export const createHostPairingService = ({
  connect,
  store,
  getRelayUrl,
  hostName = os.hostname(),
  clock = systemClock,
  maxPairings = DEFAULT_MAX_PAIRINGS,
  lockStore = createConfigPairLockStore(),
}: HostPairingServiceOptions) => {
  const name = sanitizeDeviceName(hostName);
  const sessions = new Map<string, Session>();
  let activeId: string | null = null;
  /** In-memory copy of the lock: still enforced when persisting it failed. */
  let lockedUntil = 0;

  /** The lock in force: the persisted value wins over memory when later, and an unreadable database throws. */
  const currentLock = (): number => Math.max(lockedUntil, lockStore.read());

  const startLock = (): void => {
    lockedUntil = clock.now() + PAIRING_LOCK_MS;
    try {
      lockStore.write(lockedUntil);
    } catch {
      // The in-memory lock still holds; the teardown of the ceremony must not depend on the disk.
    }
  };

  const sendFrames = (session: Session, frames: Buffer[]): void => {
    if (session.channelClosed) return;
    for (const frame of frames) session.channel?.sendFrame(frame);
  };

  /** Ends a session exactly once: stops its timer, applies the lock rule, and tears the room down. */
  const finish = (session: Session, failure: RemotePairingFailure | null): void => {
    if (session.finished) return;
    session.finished = true;
    session.failure = failure;
    session.finishedAt = clock.now();
    session.cancelExpiry();
    if (failure === 'sas-attempts-exhausted') startLock();
    if (!session.channelClosed) {
      session.channelClosed = true;
      session.channel?.sendDestroy();
      session.channel?.close();
    }
    if (activeId === session.id) activeId = null;
  };

  /** Stores the pairing once the Controller's key confirmation verified. */
  const complete = (session: Session): void => {
    const result = session.ceremony.takeResult();
    if (!result) return finish(session, 'protocol-violation');
    try {
      if (store.countActivePairings('host') >= maxPairings) return finish(session, 'limit-reached');
      session.pairingId = store.insertPairing({ role: 'host', peerName: result.peerName, k: result.k, relayUrl: getRelayUrl() }).id;
    } catch (error) {
      session.failureCause = describeFailureCause(error);
      return finish(session, 'storage-error');
    } finally {
      result.k.fill(0);
    }
    finish(session, null);
  };

  const expire = (session: Session): void => {
    if (session.finished) return;
    sendFrames(session, session.ceremony.abort('expired'));
    finish(session, 'expired');
  };

  /** Applies whatever the ceremony decided after an event: fail, complete, or keep waiting. */
  const settle = (session: Session): void => {
    if (session.finished) return;
    const { state, failure } = session.ceremony;
    if (state === 'failed') finish(session, failure);
    else if (state === 'done') complete(session);
  };

  const requireSession = (id: string): Session => {
    const session = sessions.get(id);
    if (!session) throw new PairingError('PAIRING_NOT_FOUND', 'No such pairing in progress.');
    if (!session.finished && clock.now() >= session.expiresAt) expire(session);
    return session;
  };

  const publicState = (session: Session): RemoteHostPairingState => {
    if (session.finished) return session.pairingId ? 'done' : 'failed';
    const { state } = session.ceremony;
    return state === 'awaiting-sas' || state === 'confirming' ? 'awaiting-sas' : 'waiting-controller';
  };

  /** The Host user cancelled or rejected the pairing. Idempotent; unknown ids are ignored. */
  const cancel = (pairingId: string): void => {
    const session = sessions.get(pairingId);
    if (!session || session.finished) return;
    sendFrames(session, session.ceremony.abort('cancelled'));
    finish(session, 'cancelled');
  };

  return {
    /**
     * Starts a pairing: returns the code to show (`XXXX-XXXX`) and its expiry. A running pairing
     * nobody joined is cancelled and replaced; one a Controller has joined is returned unchanged
     * (never cancelled, so a double click cannot lock or break it). Throws `PairingError`
     * `PAIRING_LOCKED` or `PAIRING_LIMIT`.
     */
    start(): { pairingId: string; code: string; expiresAt: number } {
      if (activeId) {
        const running = sessions.get(activeId);
        if (running && !running.finished && clock.now() >= running.expiresAt) expire(running);
        if (running && !running.finished && running.ceremony.controllerName !== null) {
          return { pairingId: running.id, code: running.displayCode, expiresAt: running.expiresAt };
        }
        if (running) cancel(running.id);
      }
      for (const [id, session] of sessions) {
        if (session.finished && clock.now() - session.finishedAt > FINISHED_SESSION_RETENTION_MS) sessions.delete(id);
      }
      const lock = currentLock();
      if (clock.now() < lock) {
        throw new PairingError('PAIRING_LOCKED', 'Pairing is locked after a failed attempt; try again later.', lock);
      }
      if (store.countActivePairings('host') >= maxPairings) {
        throw new PairingError('PAIRING_LIMIT', `This Host already has the maximum of ${maxPairings} pairings; revoke one first.`);
      }

      const code = generatePairCode();
      const { pairRoomId, pairToken } = resolvePairCode(code);
      const session: Session = {
        id: crypto.randomUUID(),
        displayCode: formatPairCode(code),
        expiresAt: clock.now() + PAIRING_CODE_TTL_MS,
        ceremony: createHostPairingCeremony({ hostName: name }),
        channel: null,
        channelClosed: false,
        cancelExpiry: () => undefined,
        finished: false,
        failure: null,
        failureCause: null,
        pairingId: null,
        finishedAt: 0,
      };
      sessions.set(session.id, session);
      activeId = session.id;
      session.cancelExpiry = clock.setTimer(() => expire(session), PAIRING_CODE_TTL_MS);
      session.channel = connect(
        { roomId: pairRoomId, pairToken, role: 'host' },
        {
          onReady: () => undefined,
          onPeer: (up) => {
            if (up || session.finished) return;
            session.ceremony.peerLeft();
            settle(session);
          },
          onFrame: (frame) => {
            if (session.finished) return;
            sendFrames(session, session.ceremony.receive(frame));
            settle(session);
          },
          onClose: (closeCode) => {
            session.channelClosed = true;
            finish(session, failureForRelayClose(closeCode));
          },
        },
      );
      return { pairingId: session.id, code: session.displayCode, expiresAt: session.expiresAt };
    },

    /** Current view of a pairing, or null for an unknown id. Never contains the SAS. */
    getStatus(pairingId: string): RemoteHostPairingStatus | null {
      const session = sessions.get(pairingId);
      if (!session) return null;
      if (!session.finished && clock.now() >= session.expiresAt) expire(session);
      const state = publicState(session);
      const status: RemoteHostPairingStatus = { state, attemptsLeft: session.ceremony.attemptsLeft };
      if (session.ceremony.controllerName !== null) status.controllerName = session.ceremony.controllerName;
      if (state === 'failed') {
        if (session.failure) status.failure = session.failure;
        if (session.failure === 'sas-attempts-exhausted') {
          const lock = currentLock();
          if (clock.now() < lock) status.lockedUntil = lock;
        }
      }
      if (session.pairingId) status.pairingId = session.pairingId;
      return status;
    },

    /**
     * Operator diagnostics: a non-secret code (for example `SQLITE_FULL`, `MASTER_KEY_MISMATCH`) for
     * a `storage-error`, null otherwise. Deliberately not part of the status JSON.
     */
    getFailureCause(pairingId: string): string | null {
      return sessions.get(pairingId)?.failureCause ?? null;
    },

    /**
     * The Host user typed the SAS shown on the Controller. Wrong entries return
     * `{ok:false, attemptsLeft}`; the third ends the pairing and locks the Host. Throws
     * `PairingError`: `PAIRING_NOT_FOUND`, `PAIRING_NOT_READY` (no Controller SAS yet, or the
     * pairing already ended) and `INVALID_SAS` (not six digits; costs no attempt).
     */
    confirmSas(pairingId: string, sas: string): { ok: true } | { ok: false; attemptsLeft: number } {
      const session = requireSession(pairingId);
      const outcome = session.ceremony.submitSas(sas);
      if (outcome.status === 'invalid') throw new PairingError('INVALID_SAS', 'The code must be six digits.');
      if (outcome.status === 'not-ready') throw new PairingError('PAIRING_NOT_READY', 'This pairing is not waiting for a code.');
      sendFrames(session, outcome.frames);
      if (outcome.status === 'accepted') return { ok: true };
      if (outcome.attemptsLeft === 0) finish(session, 'sas-attempts-exhausted');
      return { ok: false, attemptsLeft: outcome.attemptsLeft };
    },

    cancel,
  };
};
