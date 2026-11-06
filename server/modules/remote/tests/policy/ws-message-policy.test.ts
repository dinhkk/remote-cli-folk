import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_MESSAGE_TYPES, SHELL_MESSAGE_TYPES, inspectControllerWsMessage } from '../../policy/ws-message-policy.js';

const text = (value: unknown): Buffer => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

test('the allowed message types are exactly the documented ones', () => {
  assert.deepEqual([...CHAT_MESSAGE_TYPES].sort(), ['chat.abort', 'chat.edit-send', 'chat.permission-response', 'chat.send', 'chat.stop-task', 'chat.subscribe']);
  assert.deepEqual([...SHELL_MESSAGE_TYPES].sort(), ['init', 'input', 'resize']);
});

test('/ws: every allowed type passes and the original bytes are forwarded untouched', () => {
  for (const type of CHAT_MESSAGE_TYPES.filter((candidate) => candidate !== 'chat.permission-response')) {
    // Odd spacing, key order and Unicode must survive byte for byte: the Host parses what the Controller sent.
    const raw = text(`{ "type" : "${type}",\n  "sessionId":"s-é\u{1F600}", "content": "x  y" }`);
    const verdict = inspectControllerWsMessage('chat', raw, false);
    assert.equal(verdict.ok, true, type);
    if (!verdict.ok) continue;
    assert.equal(verdict.rewritten, false);
    assert.ok(Buffer.from(verdict.payload).equals(raw), `${type} was altered`);
  }
});

test('/shell: init, input and resize pass untouched, including a large input', () => {
  for (const message of [
    { type: 'init', projectPath: '/work/p', provider: 'claude', cols: 80, rows: 24 },
    { type: 'input', data: 'ls -la\r' },
    { type: 'input', data: 'x'.repeat(200_000) },
    { type: 'resize', cols: 120, rows: 40 },
  ]) {
    const raw = text(message);
    const verdict = inspectControllerWsMessage('shell', raw, false);
    assert.ok(verdict.ok);
    assert.ok(Buffer.from(verdict.payload).equals(raw));
  }
});

test('a type of the other socket is refused', () => {
  for (const type of SHELL_MESSAGE_TYPES) {
    assert.deepEqual(inspectControllerWsMessage('chat', text({ type }), false), { ok: false, reason: 'type-not-allowed' }, `chat ${type}`);
  }
  for (const type of CHAT_MESSAGE_TYPES) {
    assert.deepEqual(inspectControllerWsMessage('shell', text({ type }), false), { ok: false, reason: 'type-not-allowed' }, `shell ${type}`);
  }
});

test('unknown, mis-cased, padded and non-string types are refused', () => {
  const types: unknown[] = [
    'chat.unknown',
    'CHAT.SEND',
    'Chat.Send',
    'chat.send ',
    ' chat.send',
    'chat.send\u0000',
    'chat.permission_response',
    'chat.permissionresponse',
    'pong',
    'ping',
    'auth',
    '',
    'constructor',
    '__proto__',
    123,
    null,
    true,
    ['chat.send'],
    { toString: 'chat.send' },
    {},
  ];
  for (const type of types) {
    assert.deepEqual(inspectControllerWsMessage('chat', text({ type }), false), { ok: false, reason: 'type-not-allowed' }, JSON.stringify(type));
  }
  assert.deepEqual(inspectControllerWsMessage('chat', text({ sessionId: 's' }), false), { ok: false, reason: 'type-not-allowed' });
  assert.deepEqual(inspectControllerWsMessage('shell', text({ Type: 'init' }), false), { ok: false, reason: 'type-not-allowed' });
});

test('binary frames are refused even when they hold valid JSON', () => {
  assert.deepEqual(inspectControllerWsMessage('chat', text({ type: 'chat.send' }), true), { ok: false, reason: 'binary-message' });
  assert.deepEqual(inspectControllerWsMessage('shell', text({ type: 'input', data: 'x' }), true), { ok: false, reason: 'binary-message' });
  assert.deepEqual(inspectControllerWsMessage('chat', Buffer.from([0, 1, 2, 3]), true), { ok: false, reason: 'binary-message' });
});

test('broken JSON, bad UTF-8 and BOM-prefixed text are refused as invalid-json', () => {
  const broken: Array<string | Buffer> = [
    '',
    ' ',
    '{',
    '{"type":"chat.send"',
    '{"type":"chat.send"} trailing',
    '{type:"chat.send"}',
    "{'type':'chat.send'}",
    'undefined',
    '﻿{"type":"chat.send"}',
    Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
    Buffer.concat([Buffer.from('{"type":"chat.send","content":"'), Buffer.from([0xc3]), Buffer.from('"}')]),
    '['.repeat(200_000),
  ];
  for (const raw of broken) {
    const verdict = inspectControllerWsMessage('chat', Buffer.isBuffer(raw) ? raw : text(raw), false);
    assert.deepEqual(verdict, { ok: false, reason: 'invalid-json' }, JSON.stringify(String(raw).slice(0, 30)));
  }
});

test('JSON that is not an object is refused as not-an-object', () => {
  for (const raw of ['null', '1', '"chat.send"', 'true', '[]', '[{"type":"chat.send"}]']) {
    assert.deepEqual(inspectControllerWsMessage('chat', text(raw), false), { ok: false, reason: 'not-an-object' }, raw);
  }
});

test('duplicate "type" keys resolve like the Host parser (the last one wins), so the check sees what the Host will read', () => {
  assert.deepEqual(inspectControllerWsMessage('chat', text('{"type":"chat.send","type":"init"}'), false), { ok: false, reason: 'type-not-allowed' });
  const verdict = inspectControllerWsMessage('chat', text('{"type":"init","type":"chat.send"}'), false);
  assert.ok(verdict.ok);
});

test('a __proto__ key does not change the verdict or the bytes', () => {
  const raw = text('{"type":"chat.send","__proto__":{"type":"init"},"content":"x"}');
  const verdict = inspectControllerWsMessage('chat', raw, false);
  assert.ok(verdict.ok);
  assert.ok(Buffer.from(verdict.payload).equals(raw));
});

test('never throws, whatever the payload', () => {
  for (const channel of ['chat', 'shell'] as const) {
    for (let length = 0; length < 64; length += 1) {
      const bytes = Buffer.alloc(length, length);
      assert.doesNotThrow(() => inspectControllerWsMessage(channel, bytes, false));
    }
  }
});
