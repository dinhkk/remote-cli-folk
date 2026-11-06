import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectControllerWsMessage } from '../../policy/ws-message-policy.js';

/**
 * FR-38 / AC-31: "Always allow" is a UX hygiene filter, not a security boundary (requirements
 * section 9: a Controller can still grant itself tools through `chat.send options`, which this
 * filter deliberately does not touch). The rule is stateless and unconditional: every
 * `chat.permission-response` loses its top-level `rememberEntry`, whatever the tool or value.
 */
const run = (message: unknown | string) =>
  inspectControllerWsMessage('chat', Buffer.from(typeof message === 'string' ? message : JSON.stringify(message), 'utf8'), false);

const parse = (verdict: ReturnType<typeof run>): Record<string, unknown> => {
  assert.ok(verdict.ok, JSON.stringify(verdict));
  return JSON.parse(Buffer.from(verdict.payload).toString('utf8')) as Record<string, unknown>;
};

const REMEMBER_VALUES: Array<[string, unknown]> = [
  ['a string', 'Bash'],
  ['a tool rule', 'Bash(git push:*)'],
  ['an empty string', ''],
  ['an object', { toolName: 'Bash', pattern: '*' }],
  ['a nested object', { a: { b: { c: [1, 2, 3] } } }],
  ['an array', ['Bash', 'Read']],
  ['null', null],
  ['zero', 0],
  ['false', false],
  ['true', true],
  ['a number', 42],
];

for (const [label, value] of REMEMBER_VALUES) {
  test(`rememberEntry is removed when it is ${label}`, () => {
    const verdict = run({ type: 'chat.permission-response', requestId: 'r1', allow: true, rememberEntry: value });
    assert.ok(verdict.ok);
    assert.equal(verdict.rewritten, true);
    const forwarded = parse(verdict);
    assert.equal(Object.hasOwn(forwarded, 'rememberEntry'), false);
    assert.deepEqual(forwarded, { type: 'chat.permission-response', requestId: 'r1', allow: true });
  });
}

test('the name of the tool does not matter: a "Bash" entry on a Read request is dropped like any other', () => {
  // The filter has no memory of which tool a requestId belongs to, and it needs none.
  const forwarded = parse(run({ type: 'chat.permission-response', requestId: 'read-1', allow: true, rememberEntry: 'Bash' }));
  assert.equal(Object.hasOwn(forwarded, 'rememberEntry'), false);
  const matching = parse(run({ type: 'chat.permission-response', requestId: 'read-1', allow: true, rememberEntry: 'Read' }));
  assert.equal(Object.hasOwn(matching, 'rememberEntry'), false);
});

test('requestId, allow, updatedInput and message are forwarded unchanged, in their original order', () => {
  const original = {
    type: 'chat.permission-response',
    requestId: 'req-é-7',
    allow: false,
    message: 'Not now — try the other approach',
    updatedInput: { command: 'ls "$HOME"', nested: { list: [1, 2, { k: null }], flag: false } },
    rememberEntry: 'Bash',
  };
  const verdict = run(original);
  assert.ok(verdict.ok);
  const { rememberEntry: _dropped, ...expected } = original;
  assert.deepEqual(parse(verdict), expected);
  assert.deepEqual(Object.keys(parse(verdict)), ['type', 'requestId', 'allow', 'message', 'updatedInput']);
});

test('AskUserQuestion answers: an "Other" text of 2 KB of Unicode reaches the agent verbatim (AC-18)', () => {
  // Emoji (surrogate pairs), combining marks, RTL text, CJK, quotes, backslashes, line separators and escapes of JSON itself.
  const unit = 'Chọn phương án B — é́ \u{1F600}\u{1F468}‍\u{1F4BB} שלום 你好 "quoted" \\back\\slash    \t\n </script> {"rememberEntry":"Bash"} ';
  let other = '';
  while (Buffer.byteLength(other, 'utf8') < 2048) other += unit;
  const updatedInput = {
    questions: [{ question: 'Which?', multiSelect: true }],
    answers: { 'Which?': ['Option A', 'Option C'], Other: other },
  };
  const verdict = run({ type: 'chat.permission-response', requestId: 'ask-1', allow: true, updatedInput, rememberEntry: 'AskUserQuestion' });
  const forwarded = parse(verdict);
  assert.deepEqual(forwarded.updatedInput, updatedInput);
  assert.equal(((forwarded.updatedInput as typeof updatedInput).answers as Record<string, unknown>).Other, other);
  assert.equal(Object.hasOwn(forwarded, 'rememberEntry'), false);
});

test('only the top-level field is removed: the same name inside updatedInput or message text is user data', () => {
  const verdict = run({
    type: 'chat.permission-response',
    requestId: 'r2',
    allow: true,
    message: 'rememberEntry should stay in prose',
    updatedInput: { rememberEntry: 'inner-value', note: 'x' },
    rememberEntry: 'outer',
  });
  const forwarded = parse(verdict);
  assert.deepEqual(forwarded.updatedInput, { rememberEntry: 'inner-value', note: 'x' });
  assert.equal(forwarded.message, 'rememberEntry should stay in prose');
  assert.equal(Object.hasOwn(forwarded, 'rememberEntry'), false);
});

test('duplicate rememberEntry keys are all dropped (JSON.parse keeps the last, the filter removes the key)', () => {
  const verdict = run('{"type":"chat.permission-response","requestId":"r3","allow":true,"rememberEntry":"a","rememberEntry":"b"}');
  assert.deepEqual(parse(verdict), { type: 'chat.permission-response', requestId: 'r3', allow: true });
});

test('a permission-response without rememberEntry is forwarded byte for byte (no re-serialisation)', () => {
  const raw = Buffer.from('{ "type" : "chat.permission-response",\n "requestId":"r4", "allow":true }', 'utf8');
  const verdict = inspectControllerWsMessage('chat', raw, false);
  assert.ok(verdict.ok);
  assert.equal(verdict.rewritten, false);
  assert.ok(Buffer.from(verdict.payload).equals(raw));
});

test('the filter is stateless: the same input gives the same output no matter what came before', () => {
  const message = { type: 'chat.permission-response', requestId: 'same', allow: true, rememberEntry: 'Bash' };
  const first = Buffer.from((run(message) as { payload: Uint8Array }).payload);
  for (let i = 0; i < 25; i += 1) {
    run({ type: 'chat.permission-response', requestId: `other-${i}`, allow: i % 2 === 0, rememberEntry: i % 3 === 0 ? 'Bash' : { x: i } });
    run({ type: 'chat.send', content: 'between' });
    assert.ok(first.equals(Buffer.from((run(message) as { payload: Uint8Array }).payload)));
  }
});

test('other message types are NOT touched: chat.send options stay as they are (hygiene filter, not a boundary)', () => {
  const raw = Buffer.from(JSON.stringify({ type: 'chat.send', sessionId: 's', content: 'hi', rememberEntry: 'Bash', options: { toolsSettings: { allowedTools: ['Bash'] }, permissionMode: 'bypassPermissions' } }));
  const verdict = inspectControllerWsMessage('chat', raw, false);
  assert.ok(verdict.ok);
  assert.equal(verdict.rewritten, false);
  assert.ok(Buffer.from(verdict.payload).equals(raw));
});
