// Independent gate implementation for tests (does not import src/gate.ts, so the Worker is checked
// against a second implementation, and both against the Python-generated phase-03 vectors).
// Pure WebCrypto: runs in workerd and in Node.
import type { RoomKind } from './relay-harness';
import { toHex } from './test-identities';

const encoder = new TextEncoder();
/** Long enough for the relay's minimum secret length (32). The phase-03 vectors use a shorter one. */
export const TEST_RELAY_SECRET = 'test-relay-secret-test-relay-secret-0123456789';

export async function referenceGate(kind: RoomKind, room: string, secret = TEST_RELAY_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${kind}:${room}`))));
}
