/**
 * Two stream tables wired back to back without a secure channel or relay: what one side
 * transmits is the other side's `receive`. Each direction can be "gated": transmit then stays
 * pending until the test steps it, which models a slow link (queues build up) and lets tests look
 * at exactly what is in flight.
 */

import type { RemoteErrorCode, RemoteMuxFrame, RemoteMuxLimits, RemoteMuxStream, RemotePairingRole, RemoteStreamOpen } from '@/shared/types.js';

import { decodeFrame } from '../../mux/frames.js';
import { createStreamTable, type StreamTable } from '../../mux/stream-table.js';

import { createManualClock, type ManualClock } from './manual-clock.js';

export type Direction = 'toHost' | 'toController';

export type LoopbackSide = {
  role: RemotePairingRole;
  table: StreamTable;
  /** Streams the peer opened, in order. */
  incoming: Array<{ stream: RemoteMuxStream; open: RemoteStreamOpen }>;
  /** Replace to install handlers or refuse streams (return an error code to refuse). */
  handleIncoming: (stream: RemoteMuxStream, open: RemoteStreamOpen) => RemoteErrorCode | void;
  /** Decoded frames of stream 0 that arrived here. */
  connectionFrames: RemoteMuxFrame[];
  /** Every frame this side handed to its link, in transmit order (decoded). */
  transmitted: RemoteMuxFrame[];
  transmitErrors: unknown[];
  handlerErrors: unknown[];
};

type Waiting = { plaintext: Buffer; resolve: () => void };

export type MuxLoopback = {
  controller: LoopbackSide;
  host: LoopbackSide;
  clock: ManualClock;
  /** Delivers `count` gated frames in a direction (in order), letting reactions run in between. */
  step(direction: Direction, count?: number): Promise<void>;
  /** Frames waiting in a gated direction. */
  waiting(direction: Direction): number;
  /** Switches a direction to immediate delivery and releases everything waiting. */
  open(direction: Direction): Promise<void>;
  /** Makes a gated direction fail the next transmit (simulates a dead socket). */
  failNextTransmit(side: 'controller' | 'host', error?: Error): void;
  tick(): Promise<void>;
};

export type MuxLoopbackOptions = {
  gated?: boolean;
  controllerLimits?: Partial<RemoteMuxLimits>;
  hostLimits?: Partial<RemoteMuxLimits>;
};

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const createMuxLoopback = (options: MuxLoopbackOptions = {}): MuxLoopback => {
  const clock = createManualClock(1_800_000_000_000);
  const gates: Record<Direction, boolean> = { toHost: options.gated ?? false, toController: options.gated ?? false };
  const queues: Record<Direction, Waiting[]> = { toHost: [], toController: [] };
  const failures: Partial<Record<'controller' | 'host', Error>> = {};
  const sides = {} as Record<'controller' | 'host', LoopbackSide>;

  const makeSide = (role: RemotePairingRole, direction: Direction, limits?: Partial<RemoteMuxLimits>): LoopbackSide => {
    const peer = () => sides[role === 'host' ? 'controller' : 'host'];
    const side: LoopbackSide = {
      role,
      incoming: [],
      handleIncoming: () => undefined,
      connectionFrames: [],
      transmitted: [],
      transmitErrors: [],
      handlerErrors: [],
      table: createStreamTable({
        role,
        clock,
        limits,
        transmit: (plaintext) => {
          const failure = failures[role];
          if (failure) {
            delete failures[role];
            return Promise.reject(failure);
          }
          try {
            side.transmitted.push(decodeFrame(plaintext));
          } catch {
            // Frames the codec refuses cannot be produced by this side; nothing to record.
          }
          if (gates[direction]) return new Promise<void>((resolve) => queues[direction].push({ plaintext, resolve }));
          peer().table.receive(plaintext);
          return undefined;
        },
        onIncomingStream: (stream, open) => {
          side.incoming.push({ stream, open });
          return side.handleIncoming(stream, open);
        },
        onConnectionFrame: (frame) => side.connectionFrames.push(frame),
        onTransmitError: (error) => side.transmitErrors.push(error),
        onHandlerError: (error) => side.handlerErrors.push(error),
      }),
    };
    return side;
  };

  sides.controller = makeSide('controller', 'toHost', options.controllerLimits);
  sides.host = makeSide('host', 'toController', options.hostLimits);

  const deliverOne = async (direction: Direction): Promise<void> => {
    const next = queues[direction].shift();
    if (!next) return;
    const receiver = direction === 'toHost' ? sides.host : sides.controller;
    receiver.table.receive(next.plaintext);
    next.resolve();
    await tick();
  };

  return {
    controller: sides.controller,
    host: sides.host,
    clock,
    async step(direction, count = 1) {
      for (let i = 0; i < count; i += 1) await deliverOne(direction);
    },
    waiting: (direction) => queues[direction].length,
    async open(direction) {
      gates[direction] = false;
      while (queues[direction].length > 0) await deliverOne(direction);
    },
    failNextTransmit(side, error = new Error('socket closed')) {
      failures[side] = error;
    },
    tick,
  };
};

