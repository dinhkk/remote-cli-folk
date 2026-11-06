/**
 * WebSocket message policy of the Host (FR-37 rule 4, FR-38), applied to every message a Controller
 * sends on `/ws` (chat) or `/shell` (terminal):
 *
 * - text frames only, holding one JSON object with a string `type` from the channel's list; anything
 *   else (binary, broken JSON, unknown type, a type of the other socket) is refused and the caller
 *   closes the stream with 4403;
 * - messages are forwarded byte for byte, with ONE exception: `chat.permission-response` always loses
 *   its top-level `rememberEntry` ("Always allow"). The rule is stateless and unconditional (no tool
 *   names, no request tracking). It is UX hygiene, not a security boundary: a Controller can still
 *   grant tools through `chat.send options` (requirements section 9), which is deliberately untouched.
 *
 * The Host's own handlers parse with `JSON.parse` too, so duplicate keys resolve identically (the
 * last one wins) and the `type` checked here is the `type` the Host will dispatch on.
 */

import type { RemoteWsChannel } from '@/shared/types.js';

/** Messages the chat socket (`/ws`) accepts from a Controller (chat-websocket.service.ts). */
// Consumed by: ws-message-policy (matching), policy tests.
export const CHAT_MESSAGE_TYPES: readonly string[] = [
  'chat.send',
  'chat.edit-send',
  'chat.abort',
  'chat.stop-task',
  'chat.subscribe',
  'chat.permission-response',
];

/** Messages the terminal socket (`/shell`) accepts from a Controller (shell-websocket.service.ts). */
// Consumed by: ws-message-policy (matching), policy tests.
export const SHELL_MESSAGE_TYPES: readonly string[] = ['init', 'input', 'resize'];

/** What to do with one Controller message: forward `payload` (rewritten or not), or close with 4403 for `reason`. Consumed by: the Host bridge (`bridge-websocket-stream`), WS policy tests. */
export type WsMessageVerdict =
  | { ok: true; payload: Uint8Array; rewritten: boolean }
  | { ok: false; reason: 'binary-message' | 'invalid-json' | 'not-an-object' | 'type-not-allowed' };

const ALLOWED_TYPES: Readonly<Record<RemoteWsChannel, ReadonlySet<string>>> = {
  chat: new Set(CHAT_MESSAGE_TYPES),
  shell: new Set(SHELL_MESSAGE_TYPES),
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Checks one Controller->Host WebSocket message. Consumed by: the Host bridge, before anything is
 * written to the loopback socket. Never throws.
 */
export function inspectControllerWsMessage(channel: RemoteWsChannel, payload: Uint8Array, binary: boolean): WsMessageVerdict {
  if (binary) return { ok: false, reason: 'binary-message' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(payload));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'not-an-object' };

  const message = parsed as Record<string, unknown>;
  if (typeof message.type !== 'string' || !ALLOWED_TYPES[channel].has(message.type)) return { ok: false, reason: 'type-not-allowed' };

  if (message.type === 'chat.permission-response' && Object.hasOwn(message, 'rememberEntry')) {
    delete message.rememberEntry;
    return { ok: true, payload: Buffer.from(JSON.stringify(message), 'utf8'), rewritten: true };
  }
  return { ok: true, payload, rewritten: false };
}
