// RelayHarness over the `ws` library against a relay at a real URL (e.g. `wrangler dev`).
// It cannot move the relay's clock, so scenarios that need `advanceClock` are skipped.
// Phase 05/06 can reuse this for any relay reachable over a socket (their fake relay included).

import WebSocket from 'ws';
import { referenceGate } from './reference-gate';
import { RelayClient, type ConnectParams, type ConnectResult, type RelayHarness } from './relay-harness';

export function nodeWsHarness(name: string, baseHttpUrl: string, secret: string): RelayHarness {
  const base = new URL(baseHttpUrl);
  const wsBase = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}`;

  return {
    name,
    origin: base.origin,

    async connect(p: ConnectParams): Promise<ConnectResult> {
      const gate = p.gate === undefined ? await referenceGate(p.kind, p.room, secret) : p.gate;
      let query: string;
      if (p.rawQuery !== undefined) {
        query = p.rawQuery;
      } else {
        const q = new URLSearchParams({ kind: p.kind, room: p.room, role: p.role });
        if (gate !== null) q.set('gate', gate);
        query = q.toString();
      }
      const ws = new WebSocket(`${wsBase}/ws?${query}`, p.origin === undefined ? {} : { origin: p.origin });

      return new Promise<ConnectResult>((resolve) => {
        const client: RelayClient = new RelayClient({
          sendText: (t) => ws.send(t),
          sendBinary: (b) => ws.send(b),
          close: (code) => ws.close(code),
        });
        ws.on('message', (data, isBinary) => {
          if (isBinary) client.push({ type: 'binary', data: new Uint8Array(data as Buffer) });
          else client.push({ type: 'text', data: (data as Buffer).toString('utf8') });
        });
        ws.on('close', (code, reason) => client.push({ type: 'close', code, reason: reason.toString('utf8') }));
        ws.on('open', () => resolve({ status: 101, client }));
        ws.on('unexpected-response', (_req, res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        });
        ws.on('error', () => undefined); // surfaced as unexpected-response / close
      });
    },

    async http(path: string) {
      const res = await fetch(`${base.origin}${path}`);
      return { status: res.status, body: await res.text() };
    },

    gate: (kind, room) => referenceGate(kind, room, secret),
  };
}
