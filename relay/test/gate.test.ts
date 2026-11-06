import { env, exports } from 'cloudflare:workers';
import { listDurableObjectIds } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { computeGate } from '../src/gate';
import worker from '../src/index';
import { newRoomId } from './support/test-identities';
import { RELAY_ORIGIN, TEST_RELAY_SECRET, referenceGate } from './support/workers-harness';
import vectors from './vectors/derivation.json';

const upgradeHeaders = (extra: Record<string, string> = {}) => ({ Upgrade: 'websocket', ...extra });

async function wsRequest(query: string, headers: Record<string, string> = upgradeHeaders()): Promise<Response> {
  return exports.default.fetch(`${RELAY_ORIGIN}/ws?${query}`, { headers });
}

async function validQuery(kind: 'link' | 'pair', room: string, role = 'host'): Promise<string> {
  return `kind=${kind}&room=${room}&role=${role}&gate=${await referenceGate(kind, room)}`;
}

describe('gate: request checks before any Durable Object is touched', () => {
  it('answers 426 to a request that is not a WebSocket upgrade', async () => {
    const room = newRoomId();
    const res = await exports.default.fetch(`${RELAY_ORIGIN}/ws?${await validQuery('link', room)}`);
    expect(res.status).toBe(426);
    await res.text();
  });

  it('answers 503 when RELAY_SECRET is not configured (missing, empty or shorter than 32 characters)', async () => {
    const room = newRoomId();
    const url = `${RELAY_ORIGIN}/ws?${await validQuery('link', room)}`;
    for (const secret of [undefined, '', 'x', 'test-relay-secret', 'a'.repeat(31)]) {
      const res = await worker.fetch(new Request(url, { headers: upgradeHeaders() }), { ROOM: env.ROOM, RELAY_SECRET: secret });
      expect(res.status, `secret length ${secret?.length}`).toBe(503);
      expect(await res.text()).toBe('relay not configured'); // never says why
    }
  });

  it('accepts a secret of exactly 32 characters', async () => {
    const room = newRoomId();
    const secret = 'k'.repeat(32);
    const gate = await referenceGate('link', room, secret);
    const request = new Request(`${RELAY_ORIGIN}/ws?kind=link&room=${room}&role=host&gate=${gate}`, { headers: upgradeHeaders() });
    const res = await worker.fetch(request, { ROOM: env.ROOM, RELAY_SECRET: secret });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close(1000);
  });

  it('answers 405 to a non-GET request, even one carrying an Upgrade header, without touching a Durable Object', async () => {
    const room = newRoomId();
    const url = `${RELAY_ORIGIN}/ws?${await validQuery('link', room)}`;
    // Calls the handler directly: the runtime's own fetch() may normalise an Upgrade request to GET.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const res = await worker.fetch(new Request(url, { method, headers: upgradeHeaders() }), env);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
      await res.text();
    }
    const plainPost = await worker.fetch(new Request(url, { method: 'POST', body: 'x' }), env);
    expect(plainPost.status).toBe(405);
    await plainPost.text();
    const ids = await listDurableObjectIds(env.ROOM);
    expect(ids.some((id) => id.equals(env.ROOM.idFromName(`link:${room}`)))).toBe(false);
  });

  it('uses the first value of a duplicated query parameter, consistently for the gate and the room', async () => {
    const room = newRoomId();
    const other = newRoomId();
    const gate = await referenceGate('link', room);
    const otherGate = await referenceGate('link', other);
    const first = await wsRequest(`kind=link&room=${room}&room=${other}&role=host&gate=${gate}`);
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    first.webSocket?.close(1000);
    const second = await wsRequest(`kind=link&room=${room}&room=${other}&role=host&gate=${otherGate}`);
    expect(second.status).toBe(401);
    await second.text();
    const gateTwice = await wsRequest(`kind=link&room=${room}&role=host&gate=${'0'.repeat(64)}&gate=${gate}`);
    expect(gateTwice.status).toBe(401);
    await gateTwice.text();
  });

  it('answers 400 when room is not exactly 32 lowercase hex characters', async () => {
    const good = newRoomId();
    for (const room of ['', 'abc', good.slice(1), `${good}0`, good.toUpperCase(), `${good.slice(2)}zz`, `${good.slice(2)}--`]) {
      const q = `kind=link&room=${room}&role=host&gate=${await referenceGate('link', room)}`;
      const res = await wsRequest(q);
      expect(res.status, `room="${room}"`).toBe(400);
      await res.text();
    }
  });

  it('answers 400 for an unknown role or kind and 400 when they are missing', async () => {
    const room = newRoomId();
    const gate = await referenceGate('link', room);
    for (const q of [
      `kind=link&room=${room}&role=admin&gate=${gate}`,
      `kind=link&room=${room}&gate=${gate}`,
      `kind=other&room=${room}&role=host&gate=${gate}`,
      `room=${room}&role=host&gate=${gate}`,
      `kind=LINK&room=${room}&role=host&gate=${gate}`,
    ]) {
      const res = await wsRequest(q);
      expect(res.status, q).toBe(400);
      await res.text();
    }
  });

  it('answers 401 for a wrong, malformed or missing gate', async () => {
    const room = newRoomId();
    const good = await referenceGate('link', room);
    const flipped = `${good.slice(0, 63)}${good.endsWith('0') ? '1' : '0'}`;
    for (const gate of [flipped, '0'.repeat(64), 'xyz', good.slice(1), good.toUpperCase(), '', await referenceGate('pair', room)]) {
      const res = await wsRequest(`kind=link&room=${room}&role=host&gate=${gate}`);
      expect(res.status, `gate="${gate.slice(0, 8)}…"`).toBe(401);
      await res.text();
    }
    const missing = await wsRequest(`kind=link&room=${room}&role=host`);
    expect(missing.status).toBe(401);
    await missing.text();
  });

  it('a gate computed for another room or another secret is rejected', async () => {
    const room = newRoomId();
    const wrongRoom = await referenceGate('link', newRoomId());
    const wrongSecret = await referenceGate('link', room, 'some-other-secret');
    for (const gate of [wrongRoom, wrongSecret]) {
      const res = await wsRequest(`kind=link&room=${room}&role=host&gate=${gate}`);
      expect(res.status).toBe(401);
      await res.text();
    }
  });

  it('rejects a foreign Origin with 403, lets a missing or same-origin Origin through', async () => {
    const room = newRoomId();
    const q = await validQuery('link', room);
    const foreign = await wsRequest(q, upgradeHeaders({ Origin: 'https://evil.example' }));
    expect(foreign.status).toBe(403);
    await foreign.text();
    const lookalike = await wsRequest(q, upgradeHeaders({ Origin: `${RELAY_ORIGIN}.evil.example` }));
    expect(lookalike.status).toBe(403);
    await lookalike.text();

    // A sandboxed iframe or a redirect can produce the literal Origin "null": never legitimate.
    const nullOrigin = await wsRequest(q, upgradeHeaders({ Origin: 'null' }));
    expect(nullOrigin.status).toBe(403);
    await nullOrigin.text();

    for (const headers of [upgradeHeaders(), upgradeHeaders({ Origin: RELAY_ORIGIN })]) {
      const ok = await wsRequest(q, headers);
      expect(ok.status).toBe(101);
      ok.webSocket?.accept();
      ok.webSocket?.close(1000);
    }
  });

  it('checks the gate before spending a Durable Object (bad requests never create a room)', async () => {
    const room = newRoomId();
    const res = await wsRequest(`kind=link&room=${room}&role=host&gate=${'0'.repeat(64)}`);
    expect(res.status).toBe(401);
    await res.text();
    // The DO namespace is derived from kind:room; a rejected request must not have instantiated it.
    const name = `link:${room}`;
    const ids = await listDurableObjectIds(env.ROOM);
    expect(ids.some((id) => id.equals(env.ROOM.idFromName(name)))).toBe(false);
  });
});

describe('gate: endpoints', () => {
  it('serves /healthz with 200 and no secrets, and nothing else (no static files, no CORS headers)', async () => {
    const res = await exports.default.fetch(`${RELAY_ORIGIN}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TEST_RELAY_SECRET);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    for (const path of ['/', '/index.html', '/ws/', '/favicon.ico', '/assets/app.js', '/healthz/x']) {
      const r = await exports.default.fetch(`${RELAY_ORIGIN}${path}`);
      expect(r.status, path).toBe(404);
      await r.text();
    }
  });

  it('reports /healthz as 503 "relay not configured" when RELAY_SECRET is missing or too short, without saying why', async () => {
    for (const secret of [undefined, '', 'short-secret', 'a'.repeat(31)]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await worker.fetch(new Request(`${RELAY_ORIGIN}/healthz`, { method }), { ROOM: env.ROOM, RELAY_SECRET: secret });
        expect(res.status, `${method} secret length ${secret?.length}`).toBe(503);
        const body = await res.text();
        if (method === 'GET') expect(body).toBe('relay not configured');
        expect(body).not.toContain('short');
        expect(body).not.toMatch(/32|length|weak/i);
      }
    }
  });

  it('answers 405 to a non-GET/HEAD /healthz request', async () => {
    const res = await exports.default.fetch(`${RELAY_ORIGIN}/healthz`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(405);
    await res.text();
  });
});

describe('gate: reference vectors from the Node side (phase 03)', () => {
  it('reproduces the independent reference gate for a link room', async () => {
    expect(await computeGate(vectors.gate.relaySecret, 'link', vectors.link.roomId)).toBe(vectors.gate.link);
  });

  it('reproduces the independent reference gate for a pair room', async () => {
    expect(await computeGate(vectors.gate.relaySecret, 'pair', vectors.pair.pairRoomId)).toBe(vectors.gate.pair);
  });

  it('treats RELAY_SECRET as raw UTF-8 text (matches the test reference implementation too)', async () => {
    expect(await referenceGate('link', vectors.link.roomId, vectors.gate.relaySecret)).toBe(vectors.gate.link);
  });

  it('the vector secret (shorter than the relay minimum) is refused by the Worker, so the vectors only pin the HMAC formula', async () => {
    expect(vectors.gate.relaySecret.length).toBeLessThan(32);
    const url = `${RELAY_ORIGIN}/ws?kind=link&room=${vectors.link.roomId}&role=host&gate=${vectors.gate.link}`;
    const res = await worker.fetch(new Request(url, { headers: upgradeHeaders() }), { ROOM: env.ROOM, RELAY_SECRET: vectors.gate.relaySecret });
    expect(res.status).toBe(503);
    await res.text();
  });

  it('accepts a WebSocket upgrade for the vector room using the gate computed with the suite secret', async () => {
    const gate = await referenceGate('link', vectors.link.roomId);
    expect(gate).not.toBe(vectors.gate.link); // different secret, different gate
    const res = await wsRequest(`kind=link&room=${vectors.link.roomId}&role=host&gate=${gate}`);
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close(1000);
  });

  it('does not accept the link gate for the pair room id and vice versa', async () => {
    const linkGate = await referenceGate('link', vectors.link.roomId);
    const pairGate = await referenceGate('pair', vectors.pair.pairRoomId);
    const a = await wsRequest(`kind=pair&room=${vectors.pair.pairRoomId}&role=host&gate=${linkGate}`);
    expect(a.status).toBe(401);
    await a.text();
    const b = await wsRequest(`kind=link&room=${vectors.link.roomId}&role=host&gate=${pairGate}`);
    expect(b.status).toBe(401);
    await b.text();
  });
});
