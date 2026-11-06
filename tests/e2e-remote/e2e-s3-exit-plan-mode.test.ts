// S3: ExitPlanMode shows the plan on the Controller tab; approving or rejecting it reaches the Host's
// provider (AC-19).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { sleep } from './support/e2e-util.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';

describe('S3 ExitPlanMode', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld({ hostEnv: { CLAUDE_TOOL_APPROVAL_TIMEOUT_MS: '1500' } });
  });
  after(async () => {
    await world.stop();
  });

  const plan = async () => {
    const token = await world.tabToken();
    const sessionId = await world.createSession(token);
    const chat = await world.openChat(token);
    chat.send({ type: 'chat.send', sessionId, content: 'e2e:plan', options: {} });
    const card = await chat.waitFor((m) => m.kind === 'permission_request' && m.toolName === 'ExitPlanMode', 'the plan card', 20_000);
    return { chat, card };
  };

  it('approving the plan lets the provider leave plan mode', async () => {
    const { chat, card } = await plan();
    assert.equal(card.input.plan, '# Plan\n- step one\n- step two');
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true });
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT plan: approved'), 'the plan to be approved');
    await chat.waitFor((m) => m.kind === 'complete', 'complete');
    chat.close();
  });

  it('rejecting the plan with a note keeps the provider in plan mode and passes the note on', async () => {
    const { chat, card } = await plan();
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: false, message: 'split step two' });
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT plan: rejected:split step two'), 'the rejection note');
    await chat.waitFor((m) => m.kind === 'complete', 'complete');
    const entry = world.host.providerLog().filter((item) => item.event === 'approval' && item.toolName === 'ExitPlanMode').at(-1);
    assert.equal(entry?.decision.behavior, 'deny');
    assert.equal(entry?.decision.message, 'split step two');
    chat.close();
  });

  it('an interactive card has no timeout: it is still waiting after the ordinary approval window (1.5 s here) passed', async () => {
    const { chat, card } = await plan();
    await sleep(3000);
    assert.equal(chat.inbox.some((m) => m.kind === 'permission_cancelled'), false);
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true });
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT plan: approved'), 'the late approval to count');
    chat.close();
  });
});
