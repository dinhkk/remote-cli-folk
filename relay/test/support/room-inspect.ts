// Read-only peeks into a Room Durable Object's SQLite storage and alarm, for white-box assertions.
import { runInDurableObject } from 'cloudflare:test';
import type { RoomKind } from './relay-harness';
import { roomStub } from './workers-harness';

export type StorageDump = Record<string, Record<string, unknown>[]>;

/** Every row of every user table, keyed by table name. */
export async function dumpRoom(kind: RoomKind, room: string): Promise<StorageDump> {
  return runInDurableObject(roomStub(kind, room), (_instance, state) => {
    const sql = state.storage.sql;
    const tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .toArray() as { name: string }[];
    const out: StorageDump = {};
    for (const { name } of tables) out[name] = sql.exec(`SELECT * FROM "${name}"`).toArray();
    return out;
  });
}

export async function roomRow(kind: RoomKind, room: string): Promise<Record<string, unknown> | undefined> {
  return (await dumpRoom(kind, room)).room?.[0];
}

/** Polls until `check` returns true (server-side work that runs just after the client saw a close). */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** True when the room has no tables at all and no alarm: nothing is stored for it. */
export async function isRoomEmpty(kind: RoomKind, room: string): Promise<boolean> {
  return Object.keys(await dumpRoom(kind, room)).length === 0 && (await pendingAlarm(kind, room)) === null;
}

export async function pendingAlarm(kind: RoomKind, room: string): Promise<number | null> {
  return runInDurableObject(roomStub(kind, room), (_instance, state) => state.storage.getAlarm());
}
