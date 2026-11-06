// S2: AskUserQuestion travels to the Controller tab and the answer (an option, or free text under "Other")
// reaches the Host's provider byte for byte (AC-18).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startWorld, type RemoteWorld } from './support/e2e-world.js';

/** Exactly 2048 UTF-8 bytes of awkward text: Vietnamese, CJK, emoji (surrogate pairs), quotes, backslashes, newlines. */
const buildOtherAnswer = (): string => {
  const unit = 'Tôi chọn phương án khác: 日本語のテキスト 🚀🎉 "quoted" \\back\\slash\nline two\t<tag> & ';
  let text = '';
  while (Buffer.byteLength(text + unit, 'utf8') < 2048) text += unit;
  while (Buffer.byteLength(text, 'utf8') < 2048) text += 'z';
  return text;
};

describe('S2 AskUserQuestion', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld();
  });
  after(async () => {
    await world.stop();
  });

  const ask = async () => {
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    chat.send({ type: 'chat.send', sessionId, content: 'e2e:ask', options: {} });
    const card = await chat.waitFor((m) => m.kind === 'permission_request' && m.toolName === 'AskUserQuestion', 'the question card', 20_000);
    return { chat, card };
  };

  it('delivers the question and the chosen option', async () => {
    const { chat, card } = await ask();
    assert.equal(card.input.questions[0].question, 'Pick one');
    assert.deepEqual(card.input.questions[0].options.map((option: { label: string }) => option.label), ['Alpha', 'Beta']);
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true, updatedInput: { ...card.input, answers: { 'Pick one': 'Beta' } } });
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT ask: allow'), 'the model to continue');
    await chat.waitFor((m) => m.kind === 'complete', 'complete');

    const entry = world.host.providerLog().filter((item) => item.event === 'approval' && item.toolName === 'AskUserQuestion').at(-1);
    assert.deepEqual(entry?.decision.updatedInput.answers, { 'Pick one': 'Beta' });
    chat.close();
  });

  it('delivers a 2 KB Unicode "Other" answer verbatim', async () => {
    const other = buildOtherAnswer();
    assert.equal(Buffer.byteLength(other, 'utf8'), 2048);
    const { chat, card } = await ask();
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true, updatedInput: { ...card.input, answers: { 'Pick one': other } } });
    await chat.waitFor((m) => m.kind === 'complete', 'complete');

    const entry = world.host.providerLog().filter((item) => item.event === 'approval' && item.toolName === 'AskUserQuestion').at(-1);
    assert.equal(entry?.decision.updatedInput.answers['Pick one'], other);
    chat.close();
  });

  it('a declined question reaches the provider as a denial', async () => {
    const { chat, card } = await ask();
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: false, message: 'skip it' });
    await chat.waitFor((m) => m.kind === 'complete', 'complete');
    const entry = world.host.providerLog().filter((item) => item.event === 'approval' && item.toolName === 'AskUserQuestion').at(-1);
    assert.equal(entry?.decision.behavior, 'deny');
    chat.close();
  });
});
