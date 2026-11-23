import assert from 'node:assert/strict';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { issueLoopbackToken } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';
import type { RemoteBridgeViolation } from '@/shared/types.js';

import { createHostBridge } from '../../bridge/host-bridge.js';
import { callThroughBridge, createBridgedLoopback, startWsCall } from '../support/bridge-test-harness.js';
import { startFakeHost } from '../support/fake-loopback-host.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';
import { withTempDatabase } from '../support/temp-database.js';

type Claims = { userId: number; username: string; iat: number; exp: number; jti?: string; typ?: unknown };

const bearer = (header: string | string[] | undefined): string => String(header ?? '').replace(/^Bearer /, '');

const withRealTokens = async (run: (context: { port: number; tokensSeen: () => string[]; }) => Promise<void>): Promise<void> => {
  const previousSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    await withTempDatabase(async () => {
      userDb.createUser('alice', 'unused-hash');
      const host = await startFakeHost();
      try {
        await run({
          port: host.port,
          tokensSeen: () => [...host.requests.map((request) => bearer(request.headers.authorization)), ...host.upgrades.map((upgrade) => bearer(upgrade.headers.authorization))],
        });
      } finally {
        await host.close();
      }
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
};

test('H-02/H-04: the loopback token is typed, process-local and lives at most 5 minutes', async () => {
  await withRealTokens(async ({ port, tokensSeen }) => {
    const bridge = createHostBridge({ port, env: {} });
    const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
    try {
      await callThroughBridge(loop, { path: '/api/projects' });
      const [token] = tokensSeen();
      const claims = jwt.decode(token) as Claims;
      assert.equal(claims.userId, userDb.getFirstUser()!.id);
      assert.ok(claims.exp - claims.iat <= 300, `lives ${claims.exp - claims.iat} s`);
      assert.equal(claims.typ, 'host-loopback');
      assert.equal(typeof claims.jti, 'string');
    } finally {
      bridge.closeAll();
    }
  });
});

test('every request and every WebSocket gets a different token: nothing is cached, even within one second', async () => {
  await withRealTokens(async ({ port, tokensSeen }) => {
    const bridge = createHostBridge({ port, env: {} });
    const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
    try {
      await Promise.all(Array.from({ length: 15 }, () => callThroughBridge(loop, { path: '/api/projects' })));
      const sockets = [startWsCall(loop, '/ws'), startWsCall(loop, '/shell'), startWsCall(loop, '/ws')];
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      for (const socket of sockets) socket.stream.closeWebSocket(1000, 'done');

      const tokens = tokensSeen();
      assert.equal(tokens.length, 18);
      assert.equal(new Set(tokens).size, 18, 'a token was reused');
      assert.equal(new Set(tokens.map((token) => (jwt.decode(token) as Claims).jti)).size, 18);
      // Independent of the bridge: the auth module itself never hands out the same token twice.
      assert.notEqual(issueLoopbackToken(), issueLoopbackToken());
    } finally {
      bridge.closeAll();
    }
  });
});

test('no route out of the Host carries a token to the Controller: responses, errors, violation reports and messages are scanned', async () => {
  await withRealTokens(async ({ port, tokensSeen }) => {
    const violations: RemoteBridgeViolation[] = [];
    const bridge = createHostBridge({ port, env: {}, onViolation: (violation) => violations.push(violation), evaluateHttp: syntheticPathPolicy });
    const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
    const seenByController: string[] = [];
    try {
      for (const spec of [
        { path: '/api/projects' },
        { path: '/api/projects/status/200' },
        { path: '/api/projects/status/401' },
        { path: '/api/projects/status/403' },
        { path: '/api/projects/status/500' },
        { path: '/api/projects/nothing-here' },
        { path: '/api/assets/files/Report.PDF' },
        { path: '/api/projects/sse' },
        { path: '/api/auth/refresh', method: 'POST' },
        { path: '/api/projects/silent-not-routed/../../auth/user' },
      ]) {
        const outcome = await callThroughBridge(loop, spec);
        seenByController.push(JSON.stringify({ response: outcome.response, end: outcome.end }));
      }
      const ws = startWsCall(loop, '/ws');
      ws.stream.sendMessage(Buffer.from('{"type":"chat.subscribe","sessions":[]}'), false);
      ws.stream.sendMessage(Buffer.from('{"type":"nope"}'), false);
      await ws.waitForEnd();
      seenByController.push(JSON.stringify({ messages: ws.messages.map((message) => message.payload.toString()), end: ws.end }));

      const tokens = tokensSeen();
      assert.ok(tokens.length >= 8, 'sanity: the Host received tokens');
      const everything = seenByController.join('\n') + JSON.stringify(violations);
      for (const token of tokens) {
        assert.ok(!everything.includes(token), 'a loopback token reached the Controller side');
        assert.ok(!everything.includes(token.split('.')[1]), 'a loopback token payload reached the Controller side');
      }
      assert.ok(!/bearer\s/i.test(everything));
    } finally {
      bridge.closeAll();
    }
  });
});

test('when no token can be issued (no user yet) the Controller gets a generic error, not the reason', async () => {
  const previousSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    await withTempDatabase(async () => {
      const bridge = createHostBridge({ port: 1, env: {} });
      const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
      try {
        const outcome = await callThroughBridge(loop, { path: '/api/projects' });
        assert.equal(outcome.end.cause, 'error');
        const message = outcome.end.cause === 'error' ? outcome.end.message : '';
        assert.equal(message, 'The Host loopback is unavailable.');
        assert.ok(!/user exists|token/i.test(message));
      } finally {
        bridge.closeAll();
      }
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
