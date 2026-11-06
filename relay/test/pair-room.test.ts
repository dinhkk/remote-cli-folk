import { describe, expect, it } from 'vitest';
import { dumpRoom, eventually, pendingAlarm, roomRow } from './support/room-inspect';
import { expectPeer, expectReady, openAndAuth } from './support/session-helpers';
import { newRoomId, randomToken, sha256Hex } from './support/test-identities';
import { advanceRoomClock, workersHarness as h } from './support/workers-harness';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function pairHost(room: string, token: string) {
  const host = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
  await expectReady(host);
  return host;
}

async function pairController(room: string, token: string) {
  const c = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
  await expectReady(c);
  return c;
}

async function wrongPairAttempt(room: string): Promise<number> {
  const c = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token: randomToken() });
  return c.nextClose();
}

describe('pair room', () => {
  it('registers with the pair token only and stores just its hash, with a 5 minute expiry alarm', async () => {
    const room = newRoomId();
    const token = randomToken();
    const before = Date.now();
    const host = await pairHost(room, token);
    const row = await roomRow('pair', room);
    expect(row?.kind).toBe('pair');
    expect(row?.host_hash).toBe(await sha256Hex(token));
    expect(row?.ctl_hash ?? null).toBeNull();
    expect(JSON.stringify(await dumpRoom('pair', room))).not.toContain(token);
    const alarm = await pendingAlarm('pair', room);
    expect(alarm).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 5 * MIN + 1_000);
    host.close();
  });

  it('expires after 5 minutes: sockets closed 4410, hashes wiped, code unusable afterwards', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await pairHost(room, token);
    const controller = await pairController(room, token);
    await expectPeer(controller, true);
    await expectPeer(host, true);

    await advanceRoomClock('pair', room, 5 * MIN - 1_000);
    expect(host.closed).toBeUndefined();
    await advanceRoomClock('pair', room, 2_000);
    expect(await host.nextClose()).toBe(4410);
    expect(await controller.nextClose()).toBe(4410);

    const row = await roomRow('pair', room);
    expect(row?.revoked).toBe(1);
    expect(row?.host_hash).toBe('');
    expect(await pendingAlarm('pair', room)).toBeGreaterThan(Date.now() + 29 * DAY); // only the tombstone wipe is left
    const late = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
    expect(await late.nextClose()).toBe(4410);
  });

  it('the TTL is fixed at registration and not extended by later connections', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await pairHost(room, token);
    const first = (await roomRow('pair', room))?.expires_at;
    await advanceRoomClock('pair', room, 3 * MIN);
    const controller = await pairController(room, token);
    expect((await roomRow('pair', room))?.expires_at).toBe(first);
    await advanceRoomClock('pair', room, 2 * MIN + 1_000);
    expect(await controller.nextClose()).toBe(4410);
    expect(await host.nextClose()).toBe(4410);
  });

  it('locks after 5 wrong tokens (the 5th is still 4401), refusing even the right token', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await pairHost(room, token);
    for (let i = 1; i <= 5; i++) expect(await wrongPairAttempt(room), `attempt ${i}`).toBe(4401);
    expect(await wrongPairAttempt(room)).toBe(4429);
    const right = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
    expect(await right.nextClose()).toBe(4429);
    host.close();
  });

  it('does not mix with link rooms: kind is part of the room identity and of the gate', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await pairHost(room, token);

    // A link-kind connection to the same room id is a different, empty room
    const link = await openAndAuth(h, { kind: 'link', room, role: 'controller', token });
    expect(await link.nextClose()).toBe(4404);
    // and a link gate does not open the pair room
    expect((await h.connect({ kind: 'pair', room, role: 'controller', gate: await h.gate('link', room) })).status).toBe(401);
    // a pair-kind Host cannot be impersonated by registering in a link room with the pair token
    expect((await roomRow('link', room))?.kind).toBeUndefined();
    host.close();
  });

  it('a Controller before the Host registered gets 4404 and does not create the room', async () => {
    const room = newRoomId();
    const c = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token: randomToken() });
    expect(await c.nextClose()).toBe(4404);
    expect(await roomRow('pair', room)).toBeUndefined();
    expect(await eventually(async () => (await pendingAlarm('pair', room)) === null)).toBe(true);
  });

  it('is removed only when BOTH sides have reported completion with destroy', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await pairHost(room, token);
    const controller = await pairController(room, token);
    await expectPeer(controller, true);
    await expectPeer(host, true);

    controller.sendJson({ t: 'destroy' });
    expect(await host.isQuietFor(300)).toBe(true);
    expect(host.closed).toBeUndefined();
    controller.sendJson({ t: 'destroy' }); // repeating the same side does not count as the other side
    expect(await host.isQuietFor(300)).toBe(true);
    host.sendJson({ t: 'destroy' });
    expect(await host.nextClose()).toBe(4410);
    expect(await controller.nextClose()).toBe(4410);
    expect((await roomRow('pair', room))?.revoked).toBe(1);
    expect(await pendingAlarm('pair', room)).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('data keeps flowing between the two sides until the room ends', async () => {
    const room = newRoomId();
    const token = randomToken();
    const host = await pairHost(room, token);
    const controller = await pairController(room, token);
    await expectPeer(controller, true);
    await expectPeer(host, true);
    for (let i = 0; i < 10; i++) {
      host.sendBinary(new Uint8Array([i]));
      expect([...(await controller.nextBinary())]).toEqual([i]);
      controller.sendBinary(new Uint8Array([i + 100]));
      expect([...(await host.nextBinary())]).toEqual([i + 100]);
    }
    controller.close();
    host.close();
  });
});
