/**
 * Hardening of the Controller's WebSocket gateway: the `/shell` upgrade throttle re-checks the login after
 * its wait, caps what can queue and forgets upgrades whose browser went away; the aggregate receive budget
 * across sockets; the transport-level message ceiling of `/r` sockets; and expired pairings.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { closed, waitFor, withGatewayHarness } from '../support/ws-gateway-harness.js';

const MIB = 1024 * 1024;

describe('Remote WebSocket gateway: /shell throttle', () => {
  it('re-checks the tab token after the wait: "log out everywhere" while an upgrade is queued refuses it with 401', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 1500 }, async (h) => {
      const first = await h.openTab({ channel: 'shell' });
      const waiting = h.openTab({ channel: 'shell' }).then(
        () => 'opened',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await h.logoutAll();
      assert.equal(await waiting, 'refused:401', 'the queued upgrade completed with a token that is no longer valid');
      first.terminate();
      assert.equal(h.link.streams.length, 1, 'no stream was opened for the refused upgrade');
    });
  });

  it('re-checks the pairing after the wait: forgetting the peer while an upgrade is queued refuses it with 404', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 1000 }, async (h) => {
      const first = await h.openTab({ channel: 'shell' });
      const waiting = h.openTab({ channel: 'shell' }).then(
        () => 'opened',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      h.registry.forget(h.peerId);
      assert.equal(await waiting, 'refused:404');
      first.terminate();
    });
  });

  it('caps the queued upgrades of one pairing: the excess is refused at once with 429, the queued ones still open', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 250, shellMaxPending: 3 }, async (h) => {
      const first = await h.openTab({ channel: 'shell' });
      const queued = [1, 2, 3].map(() => h.openTab({ channel: 'shell' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const startedAt = Date.now();
      assert.equal(await h.refusal(`/r/${h.peerId}/shell`, ['cloudcli-tab', h.tabToken]), 429);
      assert.ok(Date.now() - startedAt < 200, 'the excess upgrade did not wait');

      const opened = await Promise.all(queued);
      assert.equal(opened.length, 3);
      for (const socket of [first, ...opened]) socket.terminate();
    });
  });

  it('the cap is per pairing: another pairing queues independently', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 250, shellMaxPending: 1 }, async (h) => {
      const first = await h.openTab({ channel: 'shell' });
      const queued = h.openTab({ channel: 'shell' });
      const otherToken = h.issueFor(h.otherPeerId);
      const other = await h.openTab({ channel: 'shell', peerId: h.otherPeerId, token: otherToken });
      assert.equal(other.readyState, WebSocket.OPEN);
      for (const socket of [first, await queued, other]) socket.terminate();
    });
  });

  it('forgets an upgrade whose browser went away while it waited, so it neither opens a stream nor delays the next one', async () => {
    await withGatewayHarness({ shellMinIntervalMs: 500 }, async (h) => {
      const first = await h.openTab({ channel: 'shell' });
      const startedAt = Date.now();

      const abandoned = new WebSocket(`ws://127.0.0.1:${h.port}/r/${h.peerId}/shell`, ['cloudcli-tab', h.tabToken]);
      abandoned.on('error', () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      abandoned.terminate();
      await new Promise((resolve) => setTimeout(resolve, 80));

      const third = await h.openTab({ channel: 'shell' });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 800, `the next upgrade waited ${elapsed} ms: the abandoned one still held its slot`);
      assert.equal(h.link.streams.length, 2, 'the abandoned upgrade never became a stream');
      first.terminate();
      third.terminate();
    });
  });
});

describe('Remote WebSocket gateway: aggregate receive budget', () => {
  it('cuts sockets with REMOTE_QUOTA when the unread bytes of one pairing add up over the pairing budget, though none passes its own budget', async () => {
    await withGatewayHarness({ receiveBudgets: { perStream: 256 * MIB, perPairing: 1 * MIB, global: 512 * MIB } }, async (h) => {
      const sockets = [await h.openTab(), await h.openTab(), await h.openTab()];
      const streams = [await h.nextStream(0), await h.nextStream(1), await h.nextStream(2)];
      for (const socket of sockets) socket.pause(); // browsers that stopped reading
      const chunk = Buffer.alloc(64 * 1024, 5);
      let sent = 0;
      for (let round = 0; round < 1500 && !streams.some((stream) => stream.closed); round += 1) {
        for (const stream of streams) {
          if (stream.closed) continue;
          stream.message(chunk, true);
          sent += chunk.length;
        }
        if (round % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const cut = streams.filter((stream) => stream.closed);
      assert.ok(cut.length >= 1, 'a stream was cut once the pairing total passed its budget');
      assert.ok(sent < 21 * MIB, `${sent} bytes were sent before the first cut: only a per-stream budget acted`);
      for (const stream of cut) assert.equal(stream.failure?.code, 'REMOTE_QUOTA');
      for (const socket of sockets) socket.terminate();
    });
  });
});

describe('Remote WebSocket gateway: message ceiling of the transport', () => {
  it('a message the gateway refuses (over 1 MiB) is answered with 1009 "message too big"', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      await h.nextStream();
      const gone = closed(socket);
      socket.send(Buffer.alloc(MIB + 1024, 1));
      const result = await gone;
      assert.equal(result.code, 1009);
      assert.equal(result.reason, 'message too big');
    });
  });

  it('a frame far over the ceiling is refused by the socket layer before the gateway ever sees it (1009 without the gateway\'s reason)', async () => {
    await withGatewayHarness({}, async (h) => {
      const socket = await h.openTab();
      const stream = await h.nextStream();
      const gone = closed(socket);
      socket.send(Buffer.alloc(3 * MIB, 1));
      const result = await gone;
      assert.equal(result.code, 1009);
      assert.notEqual(result.reason, 'message too big', 'the 3 MiB message reached the gateway\'s own size check, so it was buffered whole');
      await waitFor(() => stream.closed, 'the stream to end');
    });
  });
});

describe('Remote WebSocket gateway: expired pairing', () => {
  it('refuses the upgrade of an expired pairing with 410, and keeps serving the others', async () => {
    await withGatewayHarness({ peerExpiresAt: Date.now() + 60_000 }, async (h) => {
      const socket = await h.openTab();
      socket.close();
      h.clock.advance(61_000);
      assert.equal(await h.refusal(`/r/${h.peerId}/ws`, ['cloudcli-tab', h.tabToken]), 410);
      const other = await h.openTab({ peerId: h.otherPeerId, token: h.issueFor(h.otherPeerId) });
      assert.equal(other.readyState, WebSocket.OPEN);
      other.close();
    });
  });
});
