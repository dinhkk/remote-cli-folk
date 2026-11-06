// RelayHarness that talks to the real Worker + Durable Object inside workerd
// (@cloudflare/vitest-plugin). The relay clock can be moved through the Room's test hook.

import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Room } from '../../src/room';
import { RelayClient, type ConnectParams, type ConnectResult, type RelayHarness, type RoomKind } from './relay-harness';
import { TEST_RELAY_SECRET, referenceGate } from './reference-gate';

export { TEST_RELAY_SECRET, referenceGate };

export const RELAY_ORIGIN = 'https://relay.test';


export function roomStub(kind: RoomKind, room: string): DurableObjectStub<Room> {
  return env.ROOM.get(env.ROOM.idFromName(`${kind}:${room}`));
}

/** Moves the Room's clock forward WITHOUT firing the alarm (an alarm that is late or lost). */
export async function shiftRoomClock(kind: RoomKind, room: string, ms: number): Promise<void> {
  await runInDurableObject(roomStub(kind, room), (instance: Room) => {
    instance.clockOffsetMs += ms;
  });
}

/** Moves the Room's clock forward and fires its pending alarm (what real time passing would do). */
export async function advanceRoomClock(kind: RoomKind, room: string, ms: number): Promise<void> {
  await shiftRoomClock(kind, room, ms);
  await runDurableObjectAlarm(roomStub(kind, room));
}

export function buildWsUrl(p: ConnectParams, gate: string | null): string {
  if (p.rawQuery !== undefined) return `${RELAY_ORIGIN}/ws?${p.rawQuery}`;
  const q = new URLSearchParams({ kind: p.kind, room: p.room, role: p.role });
  if (gate !== null) q.set('gate', gate);
  return `${RELAY_ORIGIN}/ws?${q.toString()}`;
}

export const workersHarness: RelayHarness = {
  name: 'workerd (in-pool)',
  origin: RELAY_ORIGIN,

  async connect(p: ConnectParams): Promise<ConnectResult> {
    const gate = p.gate === undefined ? await referenceGate(p.kind, p.room) : p.gate;
    const headers = new Headers({ Upgrade: 'websocket' });
    if (p.origin !== undefined) headers.set('Origin', p.origin);
    const res = await exports.default.fetch(buildWsUrl(p, gate), { headers });
    const ws = res.webSocket;
    if (res.status !== 101 || !ws) {
      await res.text();
      return { status: res.status };
    }
    ws.binaryType = 'arraybuffer'; // the Workers default is 'blob'
    ws.accept();
    const client: RelayClient = new RelayClient({
      sendText: (t) => ws.send(t),
      sendBinary: (b) => ws.send(b),
      close: (code) => ws.close(code),
    });
    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data === 'string') client.push({ type: 'text', data });
      else client.push({ type: 'binary', data: new Uint8Array(data as ArrayBuffer) });
    });
    ws.addEventListener('close', (ev) => client.push({ type: 'close', code: ev.code, reason: ev.reason }));
    return { status: 101, client };
  },

  async http(path: string) {
    const res = await exports.default.fetch(`${RELAY_ORIGIN}${path}`);
    return { status: res.status, body: await res.text() };
  },

  gate: (kind, room) => referenceGate(kind, room),
  advanceClock: advanceRoomClock,
};
