// Relay protocol conformance scenarios (contracts.md sections 4 and 9).
//
// `scenarios` is an exported list; each scenario takes a RelayHarness ("connect factory"). Phases 05/06
// run this same list against their in-process fake relay so the fake and the real Worker cannot drift.
// Scenarios flagged `needs: 'clock'` require harness.advanceClock and are skipped otherwise.

import { describe, expect, it } from 'vitest';
import type { RelayClient, RelayHarness, RoomKind } from '../support/relay-harness';
import {
  bytes,
  expectClosedWith,
  expectPeer,
  expectReady,
  joinLinkController,
  openAndAuth,
  randomBytes,
  registerLinkHost,
} from '../support/session-helpers';
import { authFrame, makeLinkIdentity, newRoomId, randomToken } from '../support/test-identities';

export interface Scenario {
  name: string;
  needs?: 'clock';
  run(h: RelayHarness): Promise<void>;
}

const MIN = 60_000;
const MAX_BINARY = 2 * 1024 * 1024;

/** Host registers a pair room (single shared pair token, no ctl). */
async function registerPairHost(h: RelayHarness, room: string, token: string) {
  const host = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
  await expectReady(host);
  return host;
}

async function joinPairController(h: RelayHarness, room: string, token: string) {
  const controller = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
  await expectReady(controller);
  return controller;
}

async function wrongTokenAttempt(h: RelayHarness, kind: RoomKind, room: string, role: 'host' | 'controller'): Promise<number> {
  const c = await openAndAuth(h, { kind, room, role, token: randomToken() });
  return c.nextClose();
}

export const scenarios: Scenario[] = [
  // ---------------------------------------------------------------- HTTP gate
  {
    name: 'gate: /healthz answers 200 and unknown paths 404 (no static files)',
    async run(h) {
      const health = await h.http('/healthz');
      expect(health.status).toBe(200);
      expect((await h.http('/')).status).toBe(404);
      expect((await h.http('/index.html')).status).toBe(404);
    },
  },
  {
    name: 'gate: rejects bad requests before reaching a room',
    async run(h) {
      const room = newRoomId();
      expect((await h.http(`/ws?kind=link&room=${room}&role=host&gate=${'0'.repeat(64)}`)).status).toBe(426);
      expect((await h.connect({ kind: 'link', room, role: 'host', gate: '0'.repeat(64) })).status).toBe(401);
      expect((await h.connect({ kind: 'link', room, role: 'host', gate: null })).status).toBe(401);
      expect((await h.connect({ kind: 'link', room: 'abc', role: 'host', gate: await h.gate('link', 'abc') })).status).toBe(400);
      const g = await h.gate('link', room);
      expect((await h.connect({ kind: 'link', room, role: 'host', rawQuery: `kind=link&room=${room}&role=admin&gate=${g}` })).status).toBe(400);
      expect((await h.connect({ kind: 'link', room, role: 'host', rawQuery: `kind=other&room=${room}&role=host&gate=${g}` })).status).toBe(400);
      expect((await h.connect({ kind: 'link', room, role: 'host', origin: 'https://evil.example' })).status).toBe(403);
    },
  },
  {
    name: 'gate: a link gate does not open a pair room (kind is part of the gate)',
    async run(h) {
      const room = newRoomId();
      const linkGate = await h.gate('link', room);
      expect((await h.connect({ kind: 'pair', room, role: 'host', gate: linkGate })).status).toBe(401);
    },
  },
  {
    name: 'gate: same-origin Origin header is accepted',
    async run(h) {
      const res = await h.connect({ kind: 'link', room: newRoomId(), role: 'host', origin: h.origin });
      expect(res.status).toBe(101);
      res.client?.close();
    },
  },

  // ---------------------------------------------------------------- auth + roles (link)
  {
    name: 'link: Host registers first and receives ready',
    async run(h) {
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, newRoomId(), id);
      host.close();
    },
  },
  {
    name: 'link: Controller to a room that does not exist gets 4404 and it is not counted as a failure',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      for (let i = 0; i < 10; i++) {
        const c = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
        expect(await c.nextClose()).toBe(4404);
      }
      const host = await registerLinkHost(h, room, id); // not locked: 4404 attempts did not count
      const controller = await joinLinkController(h, room, id, host);
      controller.close();
      host.close();
    },
  },
  {
    name: 'link: Host registration without ctl is rejected with 4401',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
      expect(await host.nextClose()).toBe(4401);
      // and nothing was registered: a Controller still sees "no room"
      const c = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
      expect(await c.nextClose()).toBe(4404);
    },
  },
  {
    name: 'link: a stranger token after registration is refused with 4401',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      expect(await wrongTokenAttempt(h, 'link', room, 'host')).toBe(4401);
      expect(await wrongTokenAttempt(h, 'link', room, 'controller')).toBe(4401);
      expect(host.closed).toBeUndefined();
      host.close();
    },
  },
  {
    name: 'link: role comes from the token hash; a role=... hint that disagrees gets 4401 and cannot evict the real Host',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const controller = await joinLinkController(h, room, id, host);

      const asHost = await openAndAuth(h, { kind: 'link', room, role: 'controller', roleHint: 'host', token: id.controllerToken });
      expect(await asHost.nextClose()).toBe(4401);
      const asController = await openAndAuth(h, { kind: 'link', room, role: 'host', roleHint: 'controller', token: id.hostToken });
      expect(await asController.nextClose()).toBe(4401);

      // the real Host and Controller are untouched and still relay
      expect(host.closed).toBeUndefined();
      expect(controller.closed).toBeUndefined();
      controller.sendBinary(bytes(1, 2, 3));
      expect([...(await host.nextBinary())]).toEqual([1, 2, 3]);
      controller.close();
      host.close();
    },
  },
  {
    name: 'link: the first frame must be a short auth JSON, otherwise 4401',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const bad: Array<(c: RelayClient) => void> = [
        (c) => c.sendText('not json'),
        (c) => c.sendJson({ t: 'hello', token: id.hostToken }),
        (c) => c.sendJson({ t: 'auth' }),
        (c) => c.sendJson({ t: 'auth', token: 12345 }),
        (c) => c.sendBinary(bytes(1, 2, 3)),
        (c) => c.sendText(JSON.stringify({ t: 'auth', token: id.hostToken, pad: 'x'.repeat(520) })),
        (c) => c.sendText(JSON.stringify({ t: 'destroy' })),
      ];
      for (const send of bad) {
        const res = await h.connect({ kind: 'link', room, role: 'host' });
        expect(res.status).toBe(101);
        send(res.client!);
        expect(await res.client!.nextClose()).toBe(4401);
      }
      expect(host.closed).toBeUndefined();
      host.close();
    },
  },
  {
    name: 'link: no auth frame within 5 seconds closes the socket',
    async run(h) {
      const room = newRoomId();
      const res = await h.connect({ kind: 'link', room, role: 'host' });
      expect(res.status).toBe(101);
      if (h.advanceClock) {
        await h.advanceClock('link', room, 5_001);
        expect(await res.client!.nextClose(2_000)).toBe(4401);
      } else {
        // Real wall-clock wait. Local workerd (wrangler dev) delivers the Close frame on time but only
        // finishes the TCP teardown ~10 s later for closes started from an alarm, hence the long limit.
        expect(await res.client!.nextClose(20_000)).toBe(4401);
      }
    },
  },

  // ---------------------------------------------------------------- relaying
  {
    name: 'relay: ready, peer up/down, and verbatim binary in both directions in order',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const controller = await joinLinkController(h, room, id, host);

      const payloads = Array.from({ length: 40 }, (_, i) => new Uint8Array([i, 255 - i, 7, 0, 9]));
      for (const p of payloads) controller.sendBinary(p);
      for (const p of payloads) expect([...(await host.nextBinary())]).toEqual([...p]);
      host.sendBinary(randomBytes(70_000));
      expect((await controller.nextBinary()).length).toBe(70_000);

      controller.close();
      await expectPeer(host, false);
      host.close();
    },
  },
  {
    name: 'relay: data sent while the other side is absent is dropped, not queued',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      host.sendBinary(bytes(9, 9, 9)); // nobody there
      const controller = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
      await expectReady(controller);
      await expectPeer(controller, true);
      expect(await controller.isQuietFor(300)).toBe(true);
      controller.close();
      host.close();
    },
  },
  {
    name: 'relay: after auth only {"t":"destroy"} text is accepted; any other text closes with 4400',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const offenders = ['hello', '{"t":"ping"}', '{"t":"auth","token":"x"}', '{broken', '{"t":"ready"}', '[]'];
      for (const text of offenders) {
        const c = await joinLinkController(h, room, id, host);
        c.sendText(text);
        expect(await c.nextClose()).toBe(4400);
        await expectPeer(host, false);
      }
      host.close();
    },
  },
  {
    name: 'relay: a binary frame above 2 MiB closes with 1009; exactly 2 MiB passes',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const controller = await joinLinkController(h, room, id, host);
      controller.sendBinary(randomBytes(MAX_BINARY));
      expect((await host.nextBinary(10_000)).length).toBe(MAX_BINARY);
      controller.sendBinary(randomBytes(MAX_BINARY + 1));
      expect(await controller.nextClose(10_000)).toBe(1009);
      await expectPeer(host, false);
      host.close();
    },
  },
  {
    name: 'relay: a new connection of the same role closes the old one with 4409 and the peer sees down then up',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host1 = await registerLinkHost(h, room, id);
      const controller = await joinLinkController(h, room, id, host1);

      const host2 = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
      expect(await host1.nextClose()).toBe(4409);
      await expectPeer(controller, false);
      await expectPeer(controller, true);
      await expectReady(host2);
      await expectPeer(host2, true);
      expect(await controller.isQuietFor(300)).toBe(true); // the replaced socket's close adds nothing

      const controller2 = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
      expect(await controller.nextClose()).toBe(4409);
      await expectPeer(host2, false);
      await expectPeer(host2, true);
      await expectReady(controller2);
      await expectPeer(controller2, true);

      host2.sendBinary(bytes(4, 5));
      expect([...(await controller2.nextBinary())]).toEqual([4, 5]);
      controller2.close();
      host2.close();
    },
  },

  // ---------------------------------------------------------------- destroy
  {
    name: 'destroy: hostToken revokes the room, closes every socket 4410, later Controllers get 4410 at the first frame',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const controller = await joinLinkController(h, room, id, host);
      host.sendJson({ t: 'destroy' });
      expect(await host.nextClose()).toBe(4410);
      expect(await controller.nextClose()).toBe(4410);

      // upgrade still succeeds; the verdict arrives as a close code after the first frame
      const later = await h.connect({ kind: 'link', room, role: 'controller' });
      expect(later.status).toBe(101);
      later.client!.sendJson(authFrame(id.controllerToken));
      expect(await later.client!.nextClose()).toBe(4410);

      const again = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken, ctl: id.ctl });
      expect(await again.nextClose()).toBe(4410);
    },
  },
  {
    name: 'destroy: controllerToken cannot destroy; the room and the Host are unaffected',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const controller = await joinLinkController(h, room, id, host);
      controller.sendJson({ t: 'destroy' });
      await expectClosedWith(controller, 4400, 4401);
      await expectPeer(host, false);
      expect(host.closed).toBeUndefined();

      const controller2 = await joinLinkController(h, room, id, host);
      host.sendBinary(bytes(1));
      expect([...(await controller2.nextBinary())]).toEqual([1]);
      controller2.close();
      host.close();
    },
  },

  // ---------------------------------------------------------------- lockout
  {
    name: 'lockout: 8 wrong tokens lock the room with 4429, even for valid credentials',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      for (let i = 0; i < 8; i++) expect(await wrongTokenAttempt(h, 'link', room, 'controller')).toBe(4401);
      const valid = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
      expect(await valid.nextClose()).toBe(4429);
      const validHost = await openAndAuth(h, { kind: 'link', room, role: 'host', token: id.hostToken });
      expect(await validHost.nextClose()).toBe(4429);
      host.close();
    },
  },
  {
    name: 'lockout: valid credentials work again 15 minutes after the lock',
    needs: 'clock',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      for (let i = 0; i < 8; i++) await wrongTokenAttempt(h, 'link', room, 'controller');
      const locked = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
      expect(await locked.nextClose()).toBe(4429);

      await h.advanceClock!('link', room, 14 * MIN);
      const stillLocked = await openAndAuth(h, { kind: 'link', room, role: 'controller', token: id.controllerToken });
      expect(await stillLocked.nextClose()).toBe(4429);

      await h.advanceClock!('link', room, 1 * MIN + 1_000);
      const controller = await joinLinkController(h, room, id, host);
      controller.close();
      host.close();
    },
  },
  {
    name: 'lockout: failures older than 10 minutes no longer count',
    needs: 'clock',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      for (let i = 0; i < 7; i++) await wrongTokenAttempt(h, 'link', room, 'controller');
      await h.advanceClock!('link', room, 10 * MIN + 1_000);
      for (let i = 0; i < 7; i++) expect(await wrongTokenAttempt(h, 'link', room, 'controller')).toBe(4401);
      const controller = await joinLinkController(h, room, id, host); // 7 + 7 never reached 8 in one window
      controller.close();
      host.close();
    },
  },

  // ---------------------------------------------------------------- pair rooms
  {
    name: 'pair: Host registers with the pair token alone, Controller joins with the same token, data relays',
    async run(h) {
      const room = newRoomId();
      const token = randomToken();
      const host = await registerPairHost(h, room, token);
      const controller = await joinPairController(h, room, token);
      await expectPeer(controller, true);
      await expectPeer(host, true);
      host.sendBinary(bytes(7, 7));
      expect([...(await controller.nextBinary())]).toEqual([7, 7]);
      controller.sendBinary(bytes(8));
      expect([...(await host.nextBinary())]).toEqual([8]);
      controller.close();
      host.close();
    },
  },
  {
    name: 'pair: a Controller before the Host registers gets 4404; a wrong token gets 4401',
    async run(h) {
      const room = newRoomId();
      const token = randomToken();
      const early = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
      expect(await early.nextClose()).toBe(4404);
      const host = await registerPairHost(h, room, token);
      expect(await wrongTokenAttempt(h, 'pair', room, 'controller')).toBe(4401);
      host.close();
    },
  },
  {
    name: 'pair: link and pair rooms with the same id are independent',
    async run(h) {
      const room = newRoomId();
      const id = await makeLinkIdentity();
      const host = await registerLinkHost(h, room, id);
      const c = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token: id.controllerToken });
      expect(await c.nextClose()).toBe(4404);
      host.close();
    },
  },
  {
    name: 'pair: 5 wrong tokens lock the room with 4429',
    async run(h) {
      const room = newRoomId();
      const token = randomToken();
      const host = await registerPairHost(h, room, token);
      for (let i = 0; i < 5; i++) expect(await wrongTokenAttempt(h, 'pair', room, 'controller')).toBe(4401);
      const valid = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
      expect(await valid.nextClose()).toBe(4429);
      host.close();
    },
  },
  {
    name: 'pair: the room expires 5 minutes after registration (4410, code cannot be reused)',
    needs: 'clock',
    async run(h) {
      const room = newRoomId();
      const token = randomToken();
      const host = await registerPairHost(h, room, token);
      await h.advanceClock!('pair', room, 4 * MIN);
      expect(host.closed).toBeUndefined();
      await h.advanceClock!('pair', room, 1 * MIN + 1_000);
      expect(await host.nextClose()).toBe(4410);
      const late = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
      expect(await late.nextClose()).toBe(4410);
      const lateHost = await openAndAuth(h, { kind: 'pair', room, role: 'host', token });
      expect(await lateHost.nextClose()).toBe(4410);
    },
  },
  {
    name: 'pair: the room is removed once both sides have reported completion with destroy',
    async run(h) {
      const room = newRoomId();
      const token = randomToken();
      const host = await registerPairHost(h, room, token);
      const controller = await joinPairController(h, room, token);
      await expectPeer(controller, true);
      await expectPeer(host, true);
      host.sendJson({ t: 'destroy' });
      expect(await host.isQuietFor(300)).toBe(true); // one report alone does not end it
      expect(controller.closed).toBeUndefined();
      controller.sendJson({ t: 'destroy' });
      expect(await host.nextClose()).toBe(4410);
      expect(await controller.nextClose()).toBe(4410);
      const late = await openAndAuth(h, { kind: 'pair', room, role: 'controller', token });
      expect(await late.nextClose()).toBe(4410);
    },
  },
];

/** Registers every scenario as a vitest test for the given harness. */
export function runConformance(h: RelayHarness): void {
  describe(`relay conformance: ${h.name}`, () => {
    for (const scenario of scenarios) {
      const run = scenario.needs === 'clock' && !h.advanceClock ? it.skip : it;
      run(scenario.name, { timeout: 30_000 }, () => scenario.run(h));
    }
  });
}
