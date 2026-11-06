// Hibernation: the Room must work after the runtime evicts it from memory while sockets stay
// connected. `evictDurableObject` tears the instance down exactly like an idle eviction does
// (in-memory state gone, SQLite and hibernatable sockets kept). The next event re-runs the constructor.
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room';
import { pendingAlarm, roomRow } from './support/room-inspect';
import { authFrame, makeLinkIdentity, newRoomId, randomToken } from './support/test-identities';
import { expectPeer, expectReady, joinLinkController, openAndAuth, registerLinkHost } from './support/session-helpers';
import { advanceRoomClock, roomStub, workersHarness as h } from './support/workers-harness';

const MIN = 60_000;

/** Marks the live instance and evicts it; returns a check that proves a fresh instance is running. */
async function evict(kind: 'link' | 'pair', room: string): Promise<() => Promise<void>> {
  const stub = roomStub(kind, room);
  await runInDurableObject(stub, (instance: Room) => {
    (instance as unknown as { __marker?: boolean }).__marker = true;
  });
  await evictDurableObject(stub);
  return async () => {
    const survived = await runInDurableObject(stub, (instance: Room) => (instance as unknown as { __marker?: boolean }).__marker === true);
    expect(survived, 'the Durable Object instance should have been recreated').toBe(false);
  };
}

describe('hibernation', () => {
  it('keeps relaying after eviction: roles come back from the socket attachments, not from memory', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);

    const assertRecreated = await evict('link', room);
    controller.sendBinary(new Uint8Array([1, 2, 3]));
    expect([...(await host.nextBinary())]).toEqual([1, 2, 3]);
    await assertRecreated();
    host.sendBinary(new Uint8Array([9]));
    expect([...(await controller.nextBinary())]).toEqual([9]);

    // peer events still work after the wake-up
    controller.close();
    await expectPeer(host, false);
    host.close();
  });

  it('still replaces a role (4409 + peer down/up) after eviction', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);
    const assertRecreated = await evict('link', room);

    const host2 = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
    expect(await host.nextClose()).toBe(4409);
    await assertRecreated();
    await expectPeer(controller, false);
    await expectPeer(controller, true);
    await expectReady(host2);
    controller.close();
    host2.close();
  });

  it('keeps the failure counter and the lock in SQLite across eviction', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const wrong = async () => (await openAndAuth(h, { kind: 'link', room, role: 'controller', token: randomToken() })).nextClose();

    for (let i = 0; i < 5; i++) expect(await wrong()).toBe(4401);
    const assertRecreated = await evict('link', room);
    for (let i = 0; i < 3; i++) expect(await wrong()).toBe(4401); // 5 + 3 = 8 across two instances
    await assertRecreated();
    expect(await wrong()).toBe(4429);

    await evict('link', room);
    const valid = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await valid.nextClose()).toBe(4429); // lock survived another eviction
    host.close();
  });

  it('keeps registration (token hashes) across eviction: the same tokens work, strangers do not', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.close();
    const assertRecreated = await evict('link', room);

    const stranger = await openAndAuth(h, { kind: 'link', room, role: 'host', token: randomToken() });
    expect(await stranger.nextClose()).toBe(4401);
    const back = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
    await expectReady(back);
    await assertRecreated();
    back.close();
  });

  it('a socket that is still waiting to authenticate survives eviction and still times out via the alarm', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const silent = await h.connect({ kind: 'link', room, role: 'controller' });
    const eager = await h.connect({ kind: 'link', room, role: 'controller' });
    expect(await pendingAlarm('link', room)).not.toBeNull();

    await evict('link', room);
    expect(await pendingAlarm('link', room)).not.toBeNull(); // the alarm is durable
    eager.client!.sendJson(authFrame(id.controllerToken)); // first frame arrives after the wake-up
    await expectReady(eager.client!);
    await advanceRoomClock('link', room, 5_500);
    expect(await silent.client!.nextClose()).toBe(4401);
    expect(eager.client!.closed).toBeUndefined();
    eager.client!.close();
    host.close();
  });

  it('keeps the revoked marker across eviction', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.sendJson({ t: 'destroy' });
    await host.nextClose();
    await evict('link', room);
    const late = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await late.nextClose()).toBe(4410);
  });

  it('pair room expiry survives eviction (alarm and expires_at are durable)', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
    await expectReady(host);
    const expiresAt = (await roomRow('pair', room))?.expires_at;
    await evict('pair', room);
    expect((await roomRow('pair', room))?.expires_at).toBe(expiresAt);
    expect(await pendingAlarm('pair', room)).not.toBeNull();

    await advanceRoomClock('pair', room, 5 * MIN + 1_000);
    expect(await host.nextClose()).toBe(4410);
  });
});
