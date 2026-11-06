import { describe, expect, it } from 'vitest';
import { dumpRoom, pendingAlarm, roomRow } from './support/room-inspect';
import { expectPeer, joinLinkController, openAndAuth, registerLinkHost } from './support/session-helpers';
import { authFrame, makeLinkIdentity, newRoomId } from './support/test-identities';
import { workersHarness as h } from './support/workers-harness';

describe('room destroy', () => {
  it('destroy from hostToken closes every socket with 4410, including a Controller and an unauthenticated one', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);
    const pending = await h.connect({ kind: 'link', room, role: 'controller' });
    host.sendJson({ t: 'destroy' });
    expect(await host.nextClose()).toBe(4410);
    expect(await controller.nextClose()).toBe(4410);
    expect(await pending.client!.nextClose()).toBe(4410);
  });

  it('removes the token hashes and the failure log, keeping only a revoked marker', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const stranger = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: 'x'.repeat(43) });
    await stranger.nextClose();
    host.sendJson({ t: 'destroy' });
    await host.nextClose();

    const row = await roomRow('link', room);
    expect(row?.revoked).toBe(1);
    expect(row?.host_hash).toBe('');
    expect(row?.ctl_hash ?? '').toBe('');
    const dump = await dumpRoom('link', room);
    expect(dump.failures ?? []).toHaveLength(0);
    expect(JSON.stringify(dump)).not.toContain(id.ctl);
    expect(await pendingAlarm('link', room)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000); // only the tombstone wipe is left
  });

  it('a Controller arriving later gets 4410 at the first frame, not at the upgrade', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.sendJson({ t: 'destroy' });
    await host.nextClose();

    const later = await h.connect({ kind: 'link', room, role: 'controller' });
    expect(later.status).toBe(101); // the upgrade is not where revocation is reported
    expect(await later.client!.isQuietFor(200)).toBe(true); // nothing is sent before the first frame
    later.client!.sendJson(authFrame(id.controllerToken));
    expect(await later.client!.nextClose()).toBe(4410);
  });

  it('a revoked room cannot be re-registered, whatever tokens are presented', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.sendJson({ t: 'destroy' });
    await host.nextClose();

    const other = await makeLinkIdentity();
    for (const o of [
      { role: 'host' as const, token: id.hostToken, ctl: id.ctl },
      { role: 'host' as const, token: other.hostToken, ctl: other.ctl },
      { role: 'controller' as const, token: other.controllerToken },
    ]) {
      const c = await openAndAuth(h, { kind: 'link', room, ...o });
      expect(await c.nextClose()).toBe(4410);
    }
  });

  it('destroy from controllerToken is refused, closes only that socket and leaves the room intact', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);
    controller.sendJson({ t: 'destroy' });
    const code = await controller.nextClose();
    expect(code).toBe(4400);
    await expectPeer(host, false);
    expect(host.closed).toBeUndefined();
    expect((await roomRow('link', room))?.revoked).toBe(0);
    const again = await joinLinkController(h, room, id, host);
    again.close();
    host.close();
  });

  it('a Controller socket that took the Host role is impossible: controllerToken+role=host is 4401 and the Host survives', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const impostor = await openAndAuth(h, { kind: 'link', room, role: 'controller', roleHint: 'host', token: id.controllerToken });
    expect(await impostor.nextClose()).toBe(4401);
    expect(host.closed).toBeUndefined();
    // and the impostor could not have destroyed anything: a socket that failed auth sends nothing useful
    expect((await roomRow('link', room))?.revoked).toBe(0);
    host.close();
  });

  it('is idempotent: a second destroy and destroy racing with a reconnect do no harm', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.sendJson({ t: 'destroy' });
    host.sendJson({ t: 'destroy' });
    expect(await host.nextClose()).toBe(4410);
    const late = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken, ctl: id.ctl });
    expect(await late.nextClose()).toBe(4410);
  });

  it('destroy with no Controller attached still revokes (Host-only room)', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    host.sendJson({ t: 'destroy' });
    expect(await host.nextClose()).toBe(4410);
    const c = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await c.nextClose()).toBe(4410);
  });
});
