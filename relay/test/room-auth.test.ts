import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '../src/room';
import { dumpRoom, roomRow } from './support/room-inspect';
import { expectPeer, expectReady, joinLinkController, openAndAuth, registerLinkHost } from './support/session-helpers';
import { authFrame, makeLinkIdentity, newRoomId, randomToken, sha256Hex } from './support/test-identities';
import { advanceRoomClock, roomStub, workersHarness as h } from './support/workers-harness';

describe('room auth: first frame', () => {
  it('closes 4401 when the first frame is not an auth JSON or longer than 512 characters', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const exact512 = JSON.stringify({ t: 'auth', token: id.hostToken, pad: '' });
    const padded = JSON.stringify({ t: 'auth', token: id.hostToken, pad: 'p'.repeat(512 - exact512.length) });
    expect(padded.length).toBe(512);

    const tooLong = await h.connect({ kind: 'link', room, role: 'host' });
    tooLong.client!.sendText(`${padded}x`); // 513 characters
    expect(await tooLong.client!.nextClose()).toBe(4401);

    // 512 characters is still within the limit: it is parsed and, being a valid host token, accepted
    const edge = await h.connect({ kind: 'link', room, role: 'host' });
    edge.client!.sendText(padded);
    await expectReady(edge.client!);
    expect(await host.nextClose()).toBe(4409);
    edge.client!.close();
  });

  it('closes 4401 on a binary first frame and on a first frame that is the destroy command', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const a = await h.connect({ kind: 'link', room, role: 'host' });
    a.client!.sendBinary(new Uint8Array([1]));
    expect(await a.client!.nextClose()).toBe(4401);
    const b = await h.connect({ kind: 'link', room, role: 'host' });
    b.client!.sendJson({ t: 'destroy' });
    expect(await b.client!.nextClose()).toBe(4401);
    expect(host.closed).toBeUndefined(); // an unauthenticated destroy changed nothing
    host.close();
  });

  it('rejects malformed token and ctl fields with 4401 and stores nothing', async () => {
    const id = await makeLinkIdentity();
    const cases: Array<Record<string, unknown>> = [
      { t: 'auth', token: '' },
      { t: 'auth', token: 'has spaces and !!!' },
      { t: 'auth', token: 'a'.repeat(200) },
      { t: 'auth', token: id.hostToken, ctl: 'not-hex' },
      { t: 'auth', token: id.hostToken, ctl: id.ctl.toUpperCase() },
      { t: 'auth', token: id.hostToken, ctl: id.ctl.slice(2) },
      { t: 'auth', token: id.hostToken, ctl: 42 },
    ];
    for (const frame of cases) {
      const room = newRoomId();
      const res = await h.connect({ kind: 'link', room, role: 'host' });
      res.client!.sendJson(frame);
      expect(await res.client!.nextClose(), JSON.stringify(frame).slice(0, 60)).toBe(4401);
      expect(await roomRow('link', room)).toBeUndefined();
    }
  });

  it('closes a socket that sends no auth frame within 5 seconds, but not one that authenticated', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const silent = await h.connect({ kind: 'link', room, role: 'controller' });
    const slow = await h.connect({ kind: 'link', room, role: 'controller' });

    await advanceRoomClock('link', room, 4_000);
    expect(silent.client!.closed).toBeUndefined(); // not yet
    // Rooms must stay usable: this one authenticates inside the window
    slow.client!.sendJson(authFrame(id.controllerToken));
    await expectReady(slow.client!);

    await advanceRoomClock('link', room, 1_500);
    expect(await silent.client!.nextClose()).toBe(4401);
    expect(slow.client!.closed).toBeUndefined();
    expect(host.closed).toBeUndefined();
    slow.client!.close();
    host.close();
  });

  it('caps unauthenticated sockets per room', async () => {
    const room = newRoomId();
    const sockets = [];
    for (let i = 0; i < 16; i++) {
      const res = await h.connect({ kind: 'link', room, role: 'host' });
      expect(res.status).toBe(101);
      sockets.push(res.client!);
    }
    const extra = await h.connect({ kind: 'link', room, role: 'host' });
    expect(await extra.client!.nextClose()).toBe(4429);
    for (const s of sockets) s.close();
  });
});

describe('room auth: pipelined and racing first frames', () => {
  it('a second auth frame pipelined behind the first closes the socket with 4400, never replaces itself (no 4409)', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const res = await h.connect({ kind: 'link', room, role: 'controller' });
    const controller = res.client!;
    controller.sendJson(authFrame(id.controllerToken));
    controller.sendJson(authFrame(id.controllerToken));

    const texts: string[] = [];
    for (;;) {
      const m = await controller.next();
      if (m.type === 'close') {
        expect(m.code).toBe(4400);
        break;
      }
      if (m.type === 'text') texts.push(m.data);
    }
    expect(texts.map((t) => JSON.stringify(JSON.parse(t)))).toEqual([JSON.stringify({ t: 'ready' }), JSON.stringify({ t: 'peer', up: true })]);

    // The Host sees the Controller come up once and go down once: no replace churn.
    await expectPeer(host, true);
    await expectPeer(host, false);
    expect(await host.isQuietFor(300)).toBe(true);
    expect(host.closed).toBeUndefined();
    host.close();
  });

  it('two auth frames handled concurrently (interleaved at the hash await) still do not make the socket replace itself', async () => {
    // The runtime normally delivers messages one at a time. Calling the handler twice from inside the
    // object forces the interleaving the guard exists for: both frames see the socket as pending.
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const res = await h.connect({ kind: 'link', room, role: 'controller' });
    const controller = res.client!;

    await runInDurableObject(roomStub('link', room), async (instance: Room, state) => {
      const pending = state.getWebSockets().find((ws) => (ws.deserializeAttachment() as { phase?: string } | null)?.phase === 'pending')!;
      const frame = JSON.stringify(authFrame(id.controllerToken));
      await Promise.all([instance.webSocketMessage(pending, frame), instance.webSocketMessage(pending, frame)]);
    });

    const events: Array<string | number> = [];
    for (;;) {
      const m = await controller.next();
      if (m.type === 'close') {
        events.push(m.code);
        break;
      }
      if (m.type === 'text') events.push(m.data);
    }
    expect(events).toEqual(['{"t":"ready"}', '{"t":"peer","up":true}', 4400]);
    await expectPeer(host, true);
    await expectPeer(host, false);
    expect(await host.isQuietFor(300)).toBe(true);
    host.close();
  });

  it('two Hosts racing to register a fresh room: exactly one wins, the other is refused with 4401', async () => {
    const room = newRoomId();
    const idA = await makeLinkIdentity();
    const idB = await makeLinkIdentity();
    const a = (await h.connect({ kind: 'link', room, role: 'host' })).client!;
    const b = (await h.connect({ kind: 'link', room, role: 'host' })).client!;
    a.sendJson(authFrame(idA.hostToken, idA.ctl));
    b.sendJson(authFrame(idB.hostToken, idB.ctl));
    const outcome = async (c: typeof a): Promise<string | number> => {
      const m = await c.next();
      if (m.type === 'close') return m.code;
      return m.type === 'text' ? (JSON.parse(m.data) as { t: string }).t : 'binary';
    };
    const results = await Promise.all([outcome(a), outcome(b)]);
    expect(results.filter((r) => r === 'ready')).toHaveLength(1);
    expect(results.filter((r) => r === 4401)).toHaveLength(1);

    const winner = results[0] === 'ready' ? idA : idB;
    expect((await roomRow('link', room))?.host_hash).toBe(await sha256Hex(winner.hostToken));
    expect((await roomRow('link', room))?.ctl_hash).toBe(winner.ctl);
    a.close();
    b.close();
  });
});

describe('room auth: close reasons do not reveal whether a token was valid', () => {
  it('a valid token with the wrong role hint and an unknown token close with the same code and the same reason', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);

    const mismatch = await openAndAuth(h, { kind: 'link', room, role: 'controller', roleHint: 'host', token: id.controllerToken });
    const mismatchCode = await mismatch.nextClose();
    const unknown = await openAndAuth(h, { kind: 'link', room, role: 'host', token: randomToken() });
    const unknownCode = await unknown.nextClose();

    expect(mismatchCode).toBe(4401);
    expect(unknownCode).toBe(4401);
    expect(mismatch.closed?.reason).toBe(unknown.closed?.reason);
    expect(mismatch.closed?.reason).not.toMatch(/mismatch|role|bad token/i);
    host.close();
  });
});

describe('room auth: registration and role derivation', () => {
  it('stores only SHA-256 hashes of the tokens, never the tokens themselves', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    const controller = await joinLinkController(h, room, id, host);

    const row = await roomRow('link', room);
    expect(row?.host_hash).toBe(await sha256Hex(id.hostToken));
    expect(row?.ctl_hash).toBe(id.ctl);
    expect(row?.kind).toBe('link');

    const everything = JSON.stringify(await dumpRoom('link', room));
    expect(everything).not.toContain(id.hostToken);
    expect(everything).not.toContain(id.controllerToken);
    controller.close();
    host.close();
  });

  it('rejects a Host registration whose ctl equals the hash of its own hostToken', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken, ctl: await sha256Hex(id.hostToken) });
    expect(await host.nextClose()).toBe(4401);
    expect(await roomRow('link', room)).toBeUndefined();
  });

  it('a later ctl cannot rewrite the registered one (only the first registration counts)', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host1 = await registerLinkHost(h, room, id);
    const impostorCtl = await sha256Hex(randomToken());
    const host2 = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken, ctl: impostorCtl });
    await expectReady(host2);
    expect(await host1.nextClose()).toBe(4409);
    expect((await roomRow('link', room))?.ctl_hash).toBe(id.ctl);
    const controller = await joinLinkController(h, room, id, host2);
    controller.close();
    host2.close();
  });

  it('compares token hashes with crypto.subtle.timingSafeEqual', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const spy = vi.spyOn(crypto.subtle, 'timingSafeEqual');
    try {
      const host = await registerLinkHost(h, room, id);
      spy.mockClear();
      const controller = await joinLinkController(h, room, id, host);
      expect(spy).toHaveBeenCalled();
      const stranger = await openAndAuth(h, { kind: 'link', room, role: 'host', token: randomToken() });
      expect(await stranger.nextClose()).toBe(4401);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4); // both hashes compared on every attempt, no early exit
      controller.close();
      host.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('the Controller token can never take the Host role, and the real Host keeps its place', async () => {
    const room = newRoomId();
    const id = await makeLinkIdentity();
    const host = await registerLinkHost(h, room, id);
    for (let i = 0; i < 3; i++) {
      const attempt = await openAndAuth(h, { kind: 'link', room, role: 'controller', roleHint: 'host', token: id.controllerToken });
      expect(await attempt.nextClose()).toBe(4401);
    }
    expect(host.closed).toBeUndefined();
    const controller = await joinLinkController(h, room, id, host);
    host.sendBinary(new Uint8Array([5]));
    expect([...(await controller.nextBinary())]).toEqual([5]);
    controller.close();
    await expectPeer(host, false);
    host.close();
  });
});
