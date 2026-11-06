/**
 * Helpers that drive the two pairing state machines against each other in memory (no relay).
 */

import type { RemoteControllerPairingCeremony, RemoteHostPairingCeremony } from '@/shared/types.js';

import { createControllerPairingCeremony, createHostPairingCeremony } from '../../pairing/pairing-ceremony.js';

export type CeremonyPair = { host: RemoteHostPairingCeremony; controller: RemoteControllerPairingCeremony };

/** Delivers frames back and forth until neither side has anything left to send. */
export const pumpFrames = (host: RemoteHostPairingCeremony, controller: RemoteControllerPairingCeremony, firstToHost: Buffer[]): void => {
  let toHost = [...firstToHost];
  let toController: Buffer[] = [];
  for (let round = 0; round < 20 && (toHost.length > 0 || toController.length > 0); round++) {
    const hostBatch = toHost;
    toHost = [];
    for (const frame of hostBatch) toController.push(...host.receive(frame));
    const controllerBatch = toController;
    toController = [];
    for (const frame of controllerBatch) toHost.push(...controller.receive(frame));
  }
};

/** Runs a legitimate exchange up to the point where the Controller shows the SAS. */
export const runToSas = (names: { host?: string; controller?: string } = {}): CeremonyPair => {
  const host = createHostPairingCeremony({ hostName: names.host ?? 'Office PC' });
  const controller = createControllerPairingCeremony({ deviceName: names.controller ?? 'My Laptop' });
  pumpFrames(host, controller, [controller.start()]);
  return { host, controller };
};

/** Host types the SAS; both confirmations are exchanged. Returns once both sides settled. */
export const finishWithSas = ({ host, controller }: CeremonyPair, sas: string): void => {
  const outcome = host.submitSas(sas);
  if (outcome.status !== 'accepted') throw new Error(`SAS was not accepted: ${outcome.status}`);
  const toHost: Buffer[] = [];
  for (const frame of outcome.frames) toHost.push(...controller.receive(frame));
  for (const frame of toHost) host.receive(frame);
};
