// Small helpers on top of RelayHarness shared by the room tests and the conformance scenarios.

import { expect } from 'vitest';
import type { RelayClient, RelayHarness, Role, RoomKind } from './relay-harness';
import { authFrame, type LinkIdentity } from './test-identities';

export interface Opened {
  kind: RoomKind;
  room: string;
  role: Role;
  token: string;
  /** Only meaningful for the Host's first registration of a link room. */
  ctl?: string;
  /** Overrides the role=... query parameter (defaults to `role`). */
  roleHint?: Role;
}

/** Opens a socket (asserting the upgrade succeeds) and sends the auth frame. Does not wait for a reply. */
export async function openAndAuth(h: RelayHarness, o: Opened): Promise<RelayClient> {
  const res = await h.connect({ kind: o.kind, room: o.room, role: o.roleHint ?? o.role });
  expect(res.status, 'upgrade should succeed').toBe(101);
  const client = res.client!;
  client.sendJson(authFrame(o.token, o.ctl));
  return client;
}

export async function expectReady(client: RelayClient): Promise<void> {
  expect(await client.nextJson()).toEqual({ t: 'ready' });
}

export async function expectPeer(client: RelayClient, up: boolean): Promise<void> {
  expect(await client.nextJson()).toEqual({ t: 'peer', up });
}

/** Host registers a link room (first Host connection) and receives `ready`. */
export async function registerLinkHost(h: RelayHarness, room: string, id: LinkIdentity): Promise<RelayClient> {
  const host = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken, ctl: id.ctl });
  await expectReady(host);
  return host;
}

/** Controller joins an existing link room; consumes its `ready` and `peer up:true`, and the Host's `peer up:true`. */
export async function joinLinkController(h: RelayHarness, room: string, id: LinkIdentity, host?: RelayClient): Promise<RelayClient> {
  const controller = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
  await expectReady(controller);
  await expectPeer(controller, true);
  if (host) await expectPeer(host, true);
  return controller;
}

export async function expectClosedWith(client: RelayClient, ...codes: number[]): Promise<void> {
  const code = await client.nextClose();
  expect(codes).toContain(code);
}

export const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // getRandomValues is limited to 65536 bytes per call.
  for (let i = 0; i < length; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, length)));
  return out;
}
