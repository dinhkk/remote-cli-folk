// S1: a tool-permission card travels Host -> Controller tab and the decision travels back to the REAL Claude
// runtime of the Host (AC-18..21, FR-31, FR-38/AC-31). Two approval-timeout configurations:
//   - default 55 s: the Host reports it so the UI can warn; a card that outlives its timeout while the
//     Controller is away comes back as "expired" (run here with a 1.5 s timeout, never waiting 55 s);
//   - 300000 ms: the card is still valid after a 70 s loss of the link.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { RemoteSocket } from './support/e2e-browser-client.js';
import { startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';
import { sleep, waitUntil } from './support/e2e-util.js';

/** Opens the chat socket, starts a scripted turn and returns the first permission card. */
const startTurn = async (world: RemoteWorld, prompt: string) => {
  const token = await world.tabToken();
  const sessionId = await world.createSession(token);
  const chat = await world.openChat(token);
  chat.send({ type: 'chat.send', sessionId, content: prompt, options: {} });
  return { token, sessionId, chat };
};

const waitForCard = (chat: RemoteSocket, toolName: string, from = 0) =>
  chat.waitFor((m) => m.kind === 'permission_request' && m.toolName === toolName, `a ${toolName} permission card`, 20_000, from);

describe('S1 permission cards: default configuration', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld();
  });
  after(async () => {
    await world.stop();
  });

  it('shows the Bash card on the Controller; Allow reaches the provider as allow', async () => {
    const { chat } = await startTurn(world, 'e2e:permission');
    const card = await waitForCard(chat, 'Bash');
    assert.deepEqual(card.input, { command: 'echo e2e-1' });
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true });
    await chat.waitFor((m) => m.kind === 'permission_resolved' && m.requestId === card.requestId, 'permission_resolved');
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT round 1: allow'), 'the provider turn to continue');
    await chat.waitFor((m) => m.kind === 'complete', 'complete');

    const approvals = world.host.providerLog().filter((entry) => entry.event === 'approval');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].decision.behavior, 'allow');
    chat.close();
  });

  it('Deny reaches the provider as deny with the reason', async () => {
    const { chat } = await startTurn(world, 'e2e:permission');
    const card = await waitForCard(chat, 'Bash');
    chat.send({ type: 'chat.permission-response', requestId: card.requestId, allow: false, message: 'not on my machine' });
    await chat.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT round 1: deny:not on my machine'), 'the denial to reach the model');
    await chat.waitFor((m) => m.kind === 'complete', 'complete');
    const approvals = world.host.providerLog().filter((entry) => entry.event === 'approval');
    assert.equal(approvals.at(-1)?.decision.behavior, 'deny');
    assert.equal(approvals.at(-1)?.decision.message, 'not on my machine');
    chat.close();
  });

  it('drops rememberEntry on every tool: the second Bash call still asks (FR-38, AC-31)', async () => {
    const { chat } = await startTurn(world, 'e2e:permission-twice');
    const first = await waitForCard(chat, 'Bash');
    chat.send({ type: 'chat.permission-response', requestId: first.requestId, allow: true, rememberEntry: 'Bash' });
    const mark = chat.inbox.length;
    const second = await chat.waitFor((m) => m.kind === 'permission_request' && m.requestId !== first.requestId, 'a second card (nothing was remembered)', 20_000, mark - 1);
    chat.send({ type: 'chat.permission-response', requestId: second.requestId, allow: true });
    await chat.waitFor((m) => m.kind === 'complete', 'complete');

    const approvals = world.host.providerLog().filter((entry) => entry.event === 'approval').slice(-2);
    assert.equal(approvals.length, 2);
    for (const approval of approvals) assert.deepEqual(approval.allowedTools, [], 'no "always allow" entry reached the Host session');
    chat.close();
  });

  it('reports the effective approval timeout so the UI can warn below 300000 ms (FR-31)', async () => {
    const status = (await world.host.api('/api/remote/host/status')).json<{ approvalTimeoutMs: number }>();
    assert.equal(status.approvalTimeoutMs, 55_000);
  });
});

describe('S1 permission cards: 1.5 s approval timeout (stands for the 55 s default)', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld({ hostEnv: { CLAUDE_TOOL_APPROVAL_TIMEOUT_MS: '1500' } });
  });
  after(async () => {
    await world.stop();
  });

  it('a card that expired while the link was down comes back as expired, never as a live card (AC-21)', async () => {
    const { chat, sessionId, token } = await startTurn(world, 'e2e:permission');
    const card = await waitForCard(chat, 'Bash');
    const lastSeq = Math.max(...chat.inbox.map((m) => Number(m.seq ?? 0)));

    world.relay.setOutage(true);
    await chat.waitForClose(10_000); // the Controller closes the browser socket when the link dies
    await sleep(3000); // longer than the 1.5 s approval timeout on the Host
    world.relay.setOutage(false);
    await waitForPeerState(world.controller, world.peerId, 'online', 60_000);

    const again = await waitUntil(() => world.openChat(token).catch(() => null), 'the tab to reconnect', 30_000);
    again.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq }] });
    const subscribed = await again.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    // The run ended (the Host denied on timeout), so there is nothing to replay and no live card: the tab
    // learns the outcome from the transcript, and the UI marks the card it still shows as expired.
    assert.deepEqual(subscribed.pendingPermissions, [], 'nothing is waiting for an answer any more');
    assert.equal(subscribed.isProcessing, false);
    await sleep(500);
    assert.equal(again.inbox.some((m) => m.kind === 'permission_request' && m.requestId === card.requestId), false, 'the expired card is never re-offered');

    const approvals = world.host.providerLog().filter((entry) => entry.event === 'approval');
    assert.equal(approvals.at(-1)?.decision?.behavior, 'deny');
    again.close();
  });
});

describe('S1 permission cards: 300000 ms approval timeout', () => {
  let world: RemoteWorld;
  before(async () => {
    world = await startWorld({ hostEnv: { CLAUDE_TOOL_APPROVAL_TIMEOUT_MS: '300000' } });
  });
  after(async () => {
    await world.stop();
  });

  it('reports 300000 ms (no UI warning needed)', async () => {
    const status = (await world.host.api('/api/remote/host/status')).json<{ approvalTimeoutMs: number }>();
    assert.equal(status.approvalTimeoutMs, 300_000);
  });

  it('the card survives a 70 s loss of the link and Allow still reaches the provider (AC-8, 20, 21)', { timeout: 240_000 }, async () => {
    const { chat, sessionId, token } = await startTurn(world, 'e2e:permission');
    const card = await waitForCard(chat, 'Bash');
    const lastSeq = Math.max(...chat.inbox.map((m) => Number(m.seq ?? 0)));

    world.relay.setOutage(true);
    await chat.waitForClose(10_000);
    await sleep(70_000);
    assert.equal(world.host.providerLog().filter((entry) => entry.event === 'approval').length, 0, 'the provider is still waiting');
    world.relay.setOutage(false);
    await waitForPeerState(world.controller, world.peerId, 'online', 90_000);

    const again = await waitUntil(() => world.openChat(token).catch(() => null), 'the tab to reconnect', 30_000);
    again.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq }] });
    const subscribed = await again.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    assert.equal(subscribed.isProcessing, true);
    assert.equal(subscribed.pendingPermissions.length, 1);
    assert.equal(subscribed.pendingPermissions[0].requestId, card.requestId);

    again.send({ type: 'chat.permission-response', requestId: card.requestId, allow: true });
    await again.waitFor((m) => m.kind === 'text' && JSON.stringify(m).includes('RESULT round 1: allow'), 'the turn to continue');
    const approvals = world.host.providerLog().filter((entry) => entry.event === 'approval');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].decision.behavior, 'allow');
    again.close();
  });
});
