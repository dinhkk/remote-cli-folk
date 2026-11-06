import { describe, expect, it } from 'vitest';
import { expectPeer, expectReady, joinLinkController, openAndAuth, randomBytes, registerLinkHost } from './support/session-helpers';
import { makeLinkIdentity, newRoomId } from './support/test-identities';
import { workersHarness as h } from './support/workers-harness';

async function connectedPair() {
  const room = newRoomId();
  const id = await makeLinkIdentity();
  const host = await registerLinkHost(h, room, id);
  const controller = await joinLinkController(h, room, id, host);
  return { room, id, host, controller };
}

describe('room relay: forwarding', () => {
  it('forwards every byte value verbatim as binary (never as text) in both directions', async () => {
    const { host, controller } = await connectedPair();
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    controller.sendBinary(all);
    const atHost = await host.next();
    expect(atHost.type).toBe('binary');
    expect([...(atHost as { data: Uint8Array }).data]).toEqual([...all]);
    host.sendBinary(all.reverse());
    const atController = await controller.next();
    expect(atController.type).toBe('binary');
    expect((atController as { data: Uint8Array }).data[0]).toBe(255);
    controller.close();
    host.close();
  });

  it('forwards an empty binary frame', async () => {
    const { host, controller } = await connectedPair();
    controller.sendBinary(new Uint8Array(0));
    expect((await host.nextBinary()).length).toBe(0);
    controller.close();
    host.close();
  });

  it('keeps frame order under a burst of 300 frames', async () => {
    const { host, controller } = await connectedPair();
    for (let i = 0; i < 300; i++) controller.sendBinary(new Uint8Array([i & 255, i >> 8]));
    for (let i = 0; i < 300; i++) {
      const frame = await host.nextBinary();
      expect(frame[0]! + frame[1]! * 256).toBe(i);
    }
    controller.close();
    host.close();
  });

  it('relays a 2 MiB frame and closes the sender with 1009 for one byte more', async () => {
    const { host, controller } = await connectedPair();
    controller.sendBinary(randomBytes(2 * 1024 * 1024));
    expect((await host.nextBinary(10_000)).length).toBe(2 * 1024 * 1024);
    controller.sendBinary(randomBytes(2 * 1024 * 1024 + 1));
    expect(await controller.nextClose(10_000)).toBe(1009);
    await expectPeer(host, false);
    expect(host.closed).toBeUndefined();
    host.close();
  });

  it('never sends the oversized frame to the peer', async () => {
    const { host, controller } = await connectedPair();
    controller.sendBinary(randomBytes(2 * 1024 * 1024 + 10));
    await controller.nextClose(10_000);
    await expectPeer(host, false);
    expect(await host.isQuietFor(300)).toBe(true);
    host.close();
  });
});

describe('room relay: control frames', () => {
  it('sends ready, then peer up:true when the other side is already present', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    expect(await host.isQuietFor(200)).toBe(true); // alone: ready only, no peer frame
    const controller = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await controller.nextJson()).toEqual({ t: 'ready' });
    expect(await controller.nextJson()).toEqual({ t: 'peer', up: true });
    await expectPeer(host, true);
    controller.close();
    await expectPeer(host, false);
    host.close();
  });

  it('reports peer up:false exactly once per disconnect and up:true on return', async () => {
    const { room, id, host, controller } = await connectedPair();
    controller.close();
    await expectPeer(host, false);
    expect(await host.isQuietFor(200)).toBe(true);
    const again = await joinLinkController(h, room, id, host);
    again.close();
    await expectPeer(host, false);
    host.close();
  });

  it('a socket that never authenticated produces no peer events when it goes away', async () => {
    const { room, host, controller } = await connectedPair();
    const lurker = await h.connect({ kind: 'link', room, role: 'controller' });
    lurker.client!.close();
    expect(await host.isQuietFor(300)).toBe(true);
    expect(await controller.isQuietFor(50)).toBe(true);
    controller.close();
    host.close();
  });

  it('closes with 4400 for text other than destroy, including a second auth frame', async () => {
    const { host, controller } = await connectedPair();
    host.sendJson({ t: 'auth', token: 'whatever' });
    expect(await host.nextClose()).toBe(4400);
    await expectPeer(controller, false);
    controller.sendText('{"t":"ready"}');
    expect(await controller.nextClose()).toBe(4400);
  });

  it('survives a peer that disconnects abruptly while data is in flight', async () => {
    const { room, id, host, controller } = await connectedPair();
    for (let i = 0; i < 20; i++) host.sendBinary(randomBytes(1000));
    controller.close();
    await expectPeer(host, false);
    const next = await joinLinkController(h, room, id, host);
    host.sendBinary(new Uint8Array([42]));
    // frames from before the reconnect may be dropped, but the new session starts clean and ordered
    let last: Uint8Array | undefined;
    for (;;) {
      last = await next.nextBinary();
      if (last.length === 1) break;
    }
    expect(last[0]).toBe(42);
    next.close();
    host.close();
  });
});

describe('room relay: replacement', () => {
  it('replacing the Controller: old gets 4409, Host sees down then up, no extra down from the old socket', async () => {
    const { room, id, host, controller } = await connectedPair();
    const next = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
    expect(await controller.nextClose()).toBe(4409);
    await expectPeer(host, false);
    await expectPeer(host, true);
    await expectReady(next);
    await expectPeer(next, true);
    expect(await host.isQuietFor(300)).toBe(true);
    next.close();
    host.close();
  });

  it('replacing the Host while no Controller is attached notifies nobody and sends ready only', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const first = await registerLinkHost(h, room, id);
    const second = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
    expect(await first.nextClose()).toBe(4409);
    await expectReady(second);
    expect(await second.isQuietFor(200)).toBe(true);
    second.close();
  });
});
