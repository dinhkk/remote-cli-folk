// Gate: the Worker's cheap check in front of every Durable Object (contracts.md section 4).
//   gate = HMAC-SHA256(RELAY_SECRET, kind + ":" + room), hex.
// RELAY_SECRET is used as raw UTF-8 text, exactly like the Node side (server/modules/remote/crypto).
// The comparison goes through crypto.subtle.verify, which is constant-time.

import type { Env, Role, RoomKind } from './types';

export interface GateParams {
  kind: RoomKind;
  room: string;
  role: Role;
}

const ROOM_ID = /^[0-9a-f]{32}$/;
const GATE_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const text = (status: number, body: string, extra?: Record<string, string>): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });

const importKey = (secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const gateMessage = (kind: RoomKind, room: string): Uint8Array => encoder.encode(`${kind}:${room}`);

export async function computeGate(secret: string, kind: RoomKind, room: string): Promise<string> {
  const key = await importKey(secret, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, gateMessage(kind, room))));
}

async function verifyGate(secret: string, kind: RoomKind, room: string, gateHex: string): Promise<boolean> {
  if (!GATE_HEX.test(gateHex)) return false;
  const key = await importKey(secret, ['verify']);
  return crypto.subtle.verify('HMAC', key, fromHex(gateHex), gateMessage(kind, room));
}

/**
 * A secret shorter than this is treated as "not configured": the gate of every room could be
 * brute-forced offline from one observed gate. Generate one with 32 random bytes (see README).
 */
export const MIN_SECRET_LENGTH = 32;

/** True when the relay has a usable `RELAY_SECRET`. */
export const isRelayConfigured = (env: Pick<Env, 'RELAY_SECRET'>): boolean =>
  typeof env.RELAY_SECRET === 'string' && env.RELAY_SECRET.length >= MIN_SECRET_LENGTH;

/** Response for a missing or weak secret. Deliberately does not say which. */
export const notConfigured = (): Response => text(503, 'relay not configured');

/**
 * Validates an incoming `/ws` request. Returns the parsed parameters, or the Response to send back.
 * Order: method (405) -> upgrade (426) -> secret configured (503) -> Origin (403) -> parameters (400) -> gate (401).
 */
export async function checkGate(request: Request, env: Pick<Env, 'RELAY_SECRET'>): Promise<GateParams | Response> {
  if (request.method !== 'GET') return text(405, 'method not allowed', { Allow: 'GET' });
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return text(426, 'websocket upgrade required', { Upgrade: 'websocket' });
  }
  if (!isRelayConfigured(env)) return notConfigured();
  const secret = env.RELAY_SECRET!;

  const url = new URL(request.url);
  // Node clients send no Origin. A browser Origin that is not the relay itself is never legitimate.
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) return text(403, 'forbidden origin');

  const kind = url.searchParams.get('kind');
  const room = url.searchParams.get('room');
  const role = url.searchParams.get('role');
  if (kind !== 'link' && kind !== 'pair') return text(400, 'bad kind');
  if (role !== 'host' && role !== 'controller') return text(400, 'bad role');
  if (room === null || !ROOM_ID.test(room)) return text(400, 'bad room');

  const gate = url.searchParams.get('gate');
  if (gate === null || !(await verifyGate(secret, kind, room, gate))) return text(401, 'bad gate');

  return { kind, room, role };
}
