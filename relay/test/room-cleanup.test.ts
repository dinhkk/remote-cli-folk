// Storage reclaim (a room nobody registered leaves nothing behind, idle rooms and tombstones are wiped
// after 30 days) and the time rules that must not depend on the alarm firing on time.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dumpRoom, eventually, isRoomEmpty, pendingAlarm, roomRow } from './support/room-inspect';
import { expectReady, openAndAuth, registerLinkHost } from './support/session-helpers';
import { authFrame, makeLinkIdentity, newRoomId, randomToken } from './support/test-identities';
import { advanceRoomClock, roomStub, shiftRoomClock, workersHarness as h } from './support/workers-harness';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const emptyEventually = (kind: 'link' | 'pair', room: string) => eventually(() => isRoomEmpty(kind, room));

describe('rooms that never got a Host registration leave no storage and no alarm', () => {
  it('a Controller refused with 4404 (several random rooms)', async () => {
    const rooms = Array.from({ length: 5 }, () => newRoomId());
    for (const room of rooms) {
      const c = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: randomToken() });
      expect(await c.nextClose()).toBe(4404);
    }
    for (const room of rooms) expect(await emptyEventually('link', room), room).toBe(true);
  });

  it('a pair-room Controller refused with 4404', async () => {
    const room = newRoomId();
    const c = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token: randomToken() });
    expect(await c.nextClose()).toBe(4404);
    expect(await emptyEventually('pair', room)).toBe(true);
  });

  it('junk first frames: not JSON, malformed fields, a Host registration without ctl', async () => {
    const id = await makeLinkIdentity();
    const junk: Array<(room: string) => Promise<number>> = [
      async (room) => {
        const r = await h.connect({ kind: 'link', room, role: 'host' });
        r.client!.sendText('not json');
        return r.client!.nextClose();
      },
      async (room) => {
        const r = await h.connect({ kind: 'link', room, role: 'host' });
        r.client!.sendJson({ t: 'auth', token: 'has spaces!' });
        return r.client!.nextClose();
      },
      async (room) => (await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken })).nextClose(),
      async (room) => (await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken, ctl: id.ctl.replace(/./, 'z') })).nextClose(),
    ];
    for (const run of junk) {
      const room = newRoomId();
      expect(await run(room)).toBe(4401);
      expect(await emptyEventually('link', room), room).toBe(true);
    }
  });

  it('a socket that connects and goes away without sending anything, or never authenticates in time', async () => {
    const leaver = newRoomId();
    const r = await h.connect({ kind: 'link', room: leaver, role: 'host' });
    r.client!.close();
    expect(await emptyEventually('link', leaver)).toBe(true);

    const silent = newRoomId();
    const s = await h.connect({ kind: 'link', room: silent, role: 'host' });
    expect(await pendingAlarm('link', silent)).not.toBeNull(); // the auth deadline
    await advanceRoomClock('link', silent, 5_001);
    expect(await s.client!.nextClose()).toBe(4401);
    expect(await emptyEventually('link', silent)).toBe(true);
  });

  it('a room that was registered and then wiped can be registered again by the same live object', async () => {
    const room = newRoomId();
    const first = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, first);
    host.close();
    await eventually(async () => (await pendingAlarm('link', room)) !== null);
    await advanceRoomClock('link', room, 31 * DAY);
    expect(await emptyEventually('link', room)).toBe(true);

    const second = await makeLinkIdentity();
    const again = await registerLinkHost(h, room, second);
    expect((await roomRow('link', room))?.host_hash).toBeDefined();
    again.close();
  });
});

describe('idle rooms are wiped after 30 days without activity', () => {
  it('arms a single alarm about 30 days away for a registered room with nobody waiting', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.close();
    expect(await eventually(async () => ((await pendingAlarm('link', room)) ?? 0) > Date.now() + 29 * DAY)).toBe(true);
    expect((await pendingAlarm('link', room))!).toBeLessThanOrEqual(Date.now() + 30 * DAY + 5_000);
  });

  it('keeps the room just short of 30 days and wipes it just after', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.close();
    await eventually(async () => (await pendingAlarm('link', room)) !== null);

    await advanceRoomClock('link', room, 29 * DAY);
    expect((await roomRow('link', room))?.revoked).toBe(0);
    const back = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    await expectReady(back);
    back.close();
    // that Controller was activity: the idle clock restarted at day 29
    await eventually(async () => (await pendingAlarm('link', room)) !== null);
    await advanceRoomClock('link', room, 29 * DAY);
    expect((await roomRow('link', room))?.revoked).toBe(0);
    await advanceRoomClock('link', room, 2 * DAY);
    expect(await emptyEventually('link', room)).toBe(true);
  });

  it('a successful authentication refreshes the idle timer', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const registered = (await roomRow('link', room))?.last_active as number;
    host.close();
    await shiftRoomClock('link', room, 10 * DAY);
    const again = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
    await expectReady(again);
    expect(((await roomRow('link', room))?.last_active as number) - registered).toBeGreaterThanOrEqual(10 * DAY);
    again.close();
  });

  it('failed authentications and 4404s do not refresh the idle timer', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const registered = (await roomRow('link', room))?.last_active as number;
    host.close();
    await shiftRoomClock('link', room, 5 * DAY);
    const stranger = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: randomToken() });
    expect(await stranger.nextClose()).toBe(4401);
    expect((await roomRow('link', room))?.last_active).toBe(registered);
  });

  it('never wipes a room while an authenticated socket is connected, even after 30 quiet days', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    await advanceRoomClock('link', room, 31 * DAY);
    expect(host.closed).toBeUndefined();
    expect((await roomRow('link', room))?.revoked).toBe(0);
    expect(((await roomRow('link', room))?.last_active as number) - Date.now()).toBeGreaterThanOrEqual(30 * DAY);
    host.close();
  });

  it('data frames refresh the idle timer, but write at most once an hour', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const registered = (await roomRow('link', room))?.last_active as number;

    await shiftRoomClock('link', room, 30 * MIN);
    host.sendBinary(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 300));
    expect((await roomRow('link', room))?.last_active).toBe(registered);

    await shiftRoomClock('link', room, 31 * MIN);
    host.sendBinary(new Uint8Array([2]));
    expect(await eventually(async () => ((await roomRow('link', room))?.last_active as number) - registered >= 61 * MIN)).toBe(true);
    host.close();
  });
});

describe('tombstones are wiped after 30 days', () => {
  it('a destroyed link room keeps only its revoked marker for 30 days, then nothing', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.sendJson({ t: 'destroy' });
    expect(await host.nextClose()).toBe(4410);

    expect(await eventually(async () => ((await pendingAlarm('link', room)) ?? 0) > Date.now() + 29 * DAY)).toBe(true);
    await advanceRoomClock('link', room, 29 * DAY);
    expect((await roomRow('link', room))?.revoked).toBe(1);
    const late = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await late.nextClose()).toBe(4410);

    await advanceRoomClock('link', room, 2 * DAY);
    expect(await emptyEventually('link', room)).toBe(true);
  });

  it('an expired pair room is tombstoned at 5 minutes and wiped 30 days later', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
    await expectReady(host);
    await advanceRoomClock('pair', room, 5 * MIN + 1_000);
    expect(await host.nextClose()).toBe(4410);
    expect((await roomRow('pair', room))?.revoked).toBe(1);
    expect(((await pendingAlarm('pair', room)) ?? 0) - Date.now()).toBeGreaterThan(29 * DAY);

    await advanceRoomClock('pair', room, 29 * DAY);
    const late = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
    expect(await late.nextClose()).toBe(4410);
    await advanceRoomClock('pair', room, 2 * DAY);
    expect(await emptyEventually('pair', room)).toBe(true);
  });
});

describe('pair TTL is enforced at authentication time, not only by the alarm', () => {
  it('an expired code does not authenticate even though the alarm never fired', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
    await expectReady(host);

    await shiftRoomClock('pair', room, 5 * MIN + 1_000); // clock moved, alarm NOT run
    const late = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
    expect(await late.nextClose()).toBe(4410);
    expect(await host.nextClose()).toBe(4410); // the expiry also ends the room for the sockets already in it
    const row = await roomRow('pair', room);
    expect(row?.revoked).toBe(1);
    expect(row?.host_hash).toBe('');
  });

  it('the same Host token is refused too after the TTL, and a code younger than the TTL still works', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
    await expectReady(host);
    await shiftRoomClock('pair', room, 4 * MIN);
    const ok = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
    await expectReady(ok);

    await shiftRoomClock('pair', room, 2 * MIN);
    const again = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
    expect(await again.nextClose()).toBe(4410);
  });
});

describe('destroy writes the tombstone before it closes any socket', () => {
  it('both sockets are still open when the tombstone transaction runs', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    await expectReady(controller);

    const openAtTombstone: number[] = [];
    await runInDurableObject(roomStub('link', room), (_instance, state) => {
      const storage = state.storage;
      const original = storage.transactionSync.bind(storage);
      storage.transactionSync = ((fn: () => unknown) => {
        openAtTombstone.push(state.getWebSockets().filter((ws) => ws.readyState === 1).length);
        return original(fn);
      }) as typeof storage.transactionSync;
    });

    host.sendJson({ t: 'destroy' });
    expect(await host.nextClose()).toBe(4410);
    expect(await controller.nextClose()).toBe(4410);
    expect(openAtTombstone).toEqual([2]);
    expect(Object.keys(await dumpRoom('link', room))).toContain('room');
  });
});
