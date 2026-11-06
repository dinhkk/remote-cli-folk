/**
 * Permanent differential test of the Host bridge over every route of the inventory. The stand-in Host is a
 * catch-all echo: it does NOT register the routes it is judged against, so nothing here depends on what the
 * scanner found. For each `allow` route the answer that comes back through the real Host bridge (production
 * policy, real header filter, loopback client) must equal the answer of a direct call with the loopback token,
 * minus the headers the filter removes; for each `deny` route the bridge must answer `REMOTE_FORBIDDEN` and the
 * Host must never be reached.
 *
 * What this proves: header filtering both ways, loopback token injection, case and query preservation, body
 * framing, and "deny never reaches the Host" for every inventory row. What it does NOT prove: that a route
 * exists on the real server or that it is classified rightly. That is `route-inventory.test.ts` (every
 * registration is classified, each allow row has a rule of its own shape) and
 * `route-scan-matches-real-routers.test.ts` (the scanner reads the same routes the real Express routers hold).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import type { RemoteStreamEnd } from '@/shared/types.js';

import { createHostBridge } from '../../bridge/host-bridge.js';
import { filterResponseHeaders } from '../../policy/header-filter.js';
import { buildInventory, type InventoryRow } from '../support/route-inventory-table.js';
import { callThroughBridge, createBridgedLoopback } from '../support/bridge-test-harness.js';
import type { MuxLoopback } from '../support/mux-loopback.js';

const TOKEN = 'loopback-token';
const rows = buildInventory().rows;
const allowRows = rows.filter((row) => row.verdict === 'allow');
const denyRows = rows.filter((row) => row.verdict === 'deny');

/** A concrete request path of a route: params get mixed-case values (the case must survive), `*` a file name. */
const concretePath = (route: string): string => route.replace(/:[A-Za-z0-9_]+/g, 'Abc-1').replace(/\*/g, 'Report.PDF');
const hasBody = (method: string): boolean => method !== 'GET';
const errorCode = (end: RemoteStreamEnd): string | undefined => (end.cause === 'error' ? end.code : undefined);

type StandIn = { port: number; hits: () => number; close(): Promise<void> };

/** A catch-all echo: answers every path with what it saw, plus headers that must never reach the Controller. */
const startStandInHost = async (): Promise<StandIn> => {
  const app = express();
  let hits = 0;
  app.use(express.json({ type: 'application/json' }));
  app.use((req, res, next) => {
    hits += 1;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.status(401).json({ error: 'no loopback token' });
    next();
  });
  app.use((req, res) => {
    res.setHeader('X-Refreshed-Token', 'must-not-arrive');
    res.setHeader('Set-Cookie', 'sid=must-not-arrive');
    res.setHeader('X-Request-Id', String(req.headers['x-request-id'] ?? ''));
    res.json({
      method: req.method,
      url: req.originalUrl,
      body: req.body ?? null,
      contentType: req.headers['content-type'] ?? null,
      accept: req.headers.accept ?? null,
    });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

describe('every route the server mounts, through the Host bridge and directly', () => {
  let host: StandIn;
  let loop: MuxLoopback;
  let closeBridge: () => void = () => undefined;

  before(async () => {
    host = await startStandInHost();
    const bridge = createHostBridge({ port: host.port, env: {}, issueToken: () => TOKEN });
    loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
    closeBridge = () => bridge.closeAll();
  });
  after(async () => {
    closeBridge();
    await host?.close();
  });

  it('inventory sanity: allow and deny routes both exist and the stand-in answers a direct call', async () => {
    assert.ok(allowRows.length > 50 && denyRows.length > 30, `${allowRows.length} allow / ${denyRows.length} deny`);
    const direct = await fetch(`http://127.0.0.1:${host.port}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(direct.status, 200);
  });

  const allowCase = async (row: InventoryRow): Promise<void> => {
    const target = `${concretePath(row.route)}?a=1&b=two`;
    const payload = hasBody(row.method) ? JSON.stringify({ probe: `${row.method} ${row.route}` }) : undefined;
    const common = { accept: 'application/json', 'x-request-id': 'parity-1' };

    const direct = await fetch(`http://127.0.0.1:${host.port}${target}`, {
      method: row.method,
      headers: { ...common, authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
      body: payload,
    });
    const directBody = await direct.text();

    const bridged = await callThroughBridge(loop, {
      method: row.method,
      path: target,
      headers: { ...common, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
      body: payload ? [payload] : [],
    });
    assert.equal(bridged.response?.status, direct.status, `${row.method} ${target}: ${bridged.end.cause} ${JSON.stringify(bridged.end)}`);
    assert.deepEqual(JSON.parse(bridged.body.toString()), JSON.parse(directBody), `${row.method} ${target}`);

    // Headers: exactly what the response allow-list lets through of the direct answer; nothing sensitive.
    const expected = filterResponseHeaders(Object.fromEntries(direct.headers.entries()));
    const bridgedHeaders = bridged.response?.headers ?? {};
    assert.deepEqual(Object.keys(bridgedHeaders).sort(), Object.keys(expected).sort(), `${row.method} ${target}`);
    assert.equal(bridgedHeaders['content-type'], expected['content-type']);
    assert.equal(bridgedHeaders['x-request-id'], 'parity-1');
    assert.ok(!/x-refreshed-token|set-cookie|must-not-arrive/i.test(JSON.stringify(bridgedHeaders)));
  };

  for (const row of allowRows) {
    it(`allow ${row.method} ${row.route}: the bridge answers like a direct call (${row.rule})`, () => allowCase(row));
  }

  for (const row of denyRows) {
    it(`deny ${row.method} ${row.route}: REMOTE_FORBIDDEN and the Host is never reached (${row.rule})`, async () => {
      const before = host.hits();
      const outcome = await callThroughBridge(loop, {
        method: row.method,
        path: concretePath(row.route),
        headers: { accept: 'application/json' },
        body: [],
      });
      assert.equal(outcome.response, undefined, 'no response head may come back');
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', JSON.stringify(outcome.end));
      assert.equal(host.hits(), before, 'the stand-in Host saw the request');
    });
  }

  it('methods an allow route does not list are refused too (GET-only routes cannot be written to)', async () => {
    const before = host.hits();
    for (const [method, path] of [
      ['POST', '/api/projects'],
      ['PUT', '/api/git/status'],
      ['DELETE', '/api/providers/capabilities'],
      ['PATCH', '/api/file-tree/projects/p1/files'],
    ] as const) {
      const outcome = await callThroughBridge(loop, { method, path, body: [] });
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', `${method} ${path}`);
    }
    assert.equal(host.hits(), before);
  });
});
