import { describe, expect, it } from 'vitest';
import { dumpRoom, pendingAlarm } from './support/room-inspect';
import { expectReady, joinLinkController, openAndAuth, registerLinkHost } from './support/session-helpers';
import { makeLinkIdentity, newRoomId, randomToken } from './support/test-identities';
import { advanceRoomClock, workersHarness as h } from './support/workers-harness';

const MIN = 60_000;

async function strangerAttempt(room: string, role: 'host' | 'controller' = 'controller'): Promise<number> {
  const c = await openAndAuth(h, { kind: 'link', room, role, token: randomToken() });
  return c.nextClose();
}

describe('room lockout', () => {
  it('the 8th wrong token still gets 4401; from the 9th on every attempt gets 4429', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 1; i <= 8; i++) expect(await strangerAttempt(room), `attempt ${i}`).toBe(4401);
    expect(await strangerAttempt(room)).toBe(4429);
    expect(await strangerAttempt(room, 'host')).toBe(4429);
    host.close();
  });

  it('keeps already connected sockets, but refuses new valid ones while locked', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);
    for (let i = 0; i < 8; i++) await strangerAttempt(room);

    controller.sendBinary(new Uint8Array([1]));
    expect([...(await host.nextBinary())]).toEqual([1]); // established sessions keep working
    const fresh = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await fresh.nextClose()).toBe(4429);
    controller.close();
    host.close();
  });

  it('unlocks 15 minutes after the lock engaged and then accepts valid credentials', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 8; i++) await strangerAttempt(room);
    await advanceRoomClock('link', room, 15 * MIN - 5_000);
    expect(await strangerAttempt(room)).toBe(4429);
    await advanceRoomClock('link', room, 6_000);
    const controller = await joinLinkController(h, room, id, host);
    controller.close();
    host.close();
  });

  it('counts failures in a sliding 10 minute window', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 5; i++) await strangerAttempt(room);
    await advanceRoomClock('link', room, 6 * MIN);
    for (let i = 0; i < 2; i++) await strangerAttempt(room); // 5 (6 min old) + 2 = 7 in window
    await advanceRoomClock('link', room, 5 * MIN); // the first 5 are now 11 min old
    for (let i = 0; i < 5; i++) expect(await strangerAttempt(room)).toBe(4401); // 2 + 5 = 7, still below 8
    expect(await strangerAttempt(room)).toBe(4401); // 8th inside the window engages the lock
    expect(await strangerAttempt(room)).toBe(4429);
    host.close();
  });

  it('does not count 4404 (no room yet) or a valid token with the wrong role hint', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    for (let i = 0; i < 12; i++) {
      const c = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: randomToken() });
      expect(await c.nextClose()).toBe(4404);
    }
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 12; i++) {
      const c = await openAndAuth(h, { kind: 'link', room, role: 'controller', roleHint: 'host', token: id.controllerToken });
      expect(await c.nextClose()).toBe(4401);
    }
    const controller = await joinLinkController(h, room, id, host);
    controller.close();
    host.close();
  });

  it('does not count malformed first frames as wrong tokens', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 12; i++) {
      const res = await h.connect({ kind: 'link', room, role: 'controller' });
      res.client!.sendText('garbage');
      expect(await res.client!.nextClose()).toBe(4401);
    }
    const controller = await joinLinkController(h, room, id, host);
    controller.close();
    host.close();
  });

  it('keeps the failure log and lock in SQLite, with no token material', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 3; i++) await strangerAttempt(room);
    const afterThree = await dumpRoom('link', room);
    expect(afterThree.failures).toHaveLength(3);
    expect(Object.keys(afterThree.failures![0]!)).toEqual(['at']); // timestamps only
    for (let i = 0; i < 5; i++) await strangerAttempt(room);
    const locked = await dumpRoom('link', room);
    expect(locked.lock?.[0]?.until).toBeGreaterThan(Date.now());
    expect(JSON.stringify(locked)).not.toContain(id.hostToken);
    host.close();
  });

  it('locks per room: a locked room does not affect another room', async () => {
    const roomA = newRoomId();
    const roomB = newRoomId();
    const idA = await makeLinkIdentity();
    const idB = await makeLinkIdentity();
    const hostA = await registerLinkHost(h, roomA, idA);
    const hostB = await registerLinkHost(h, roomB, idB);
    for (let i = 0; i < 9; i++) await strangerAttempt(roomA);
    expect(await strangerAttempt(roomA)).toBe(4429);
    const controllerB = await openAndAuth(h, { kind: 'link', room: roomB, role: 'controller', token: idB.controllerToken });
    await expectReady(controllerB);
    controllerB.close();
    hostA.close();
    hostB.close();
  });

  it('needs no timers: the lock expires lazily and adds no alarm (only the 30 day idle wipe is armed)', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 9; i++) await strangerAttempt(room);
    expect(await pendingAlarm('link', room)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
    host.close();
  });
});
