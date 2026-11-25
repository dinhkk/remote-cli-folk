/**
 * The Host bridge with a pairing quota and an audit receiver (FR-39, FR-42, AC-30, AC-32): a refused
 * stream gets `ERROR REMOTE_QUOTA` and exactly one audit event, old streams keep running, slots are freed
 * on close, and approval decisions, terminal open/close and file writes are reported without content.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteAuditEvent, RemoteStreamEnd } from '@/shared/types.js';

import { createHostBridge, type HostBridge, type HostBridgeOptions } from '../../bridge/host-bridge.js';
import { createPairingQuota, type PairingQuota } from '../../quota/pairing-quota.service.js';
import { callThroughBridge, startHttpCall, startWsCall } from '../support/bridge-test-harness.js';
import { startFakeHost, type FakeHost } from '../support/fake-loopback-host.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMuxLoopback, type MuxLoopback } from '../support/mux-loopback.js';
import { waitFor } from '../support/relay-link-rig.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';

type Context = { host: FakeHost; bridge: HostBridge; loop: MuxLoopback; events: RemoteAuditEvent[]; quota: PairingQuota; limitTrips: () => number };

let tokenCounter = 0;
const errorCode = (end: RemoteStreamEnd | undefined): string | undefined => (end?.cause === 'error' ? end.code : undefined);

const withBridge = async (
  run: (context: Context) => Promise<void>,
  limits: Parameters<typeof createPairingQuota>[0]['limits'] = {},
  extra: Partial<HostBridgeOptions> = {},
): Promise<void> => {
  const host = await startFakeHost();
  const events: RemoteAuditEvent[] = [];
  let trips = 0;
  const quota = createPairingQuota({ limits, clock: createManualClock(1_000_000), onViolationLimit: () => (trips += 1) });
  const bridge = createHostBridge({
    port: host.port,
    env: {},
    issueToken: () => `loopback-token-${(tokenCounter += 1)}`,
    evaluateHttp: syntheticPathPolicy,
    quota,
    onAudit: (event) => events.push(event),
    ...extra,
  });
  const loop = createMuxLoopback();
  loop.host.handleIncoming = (stream, open) => bridge.handleStream(stream, open);
  try {
    await run({ host, bridge, loop, events, quota, limitTrips: () => trips });
  } finally {
    bridge.closeAll();
    await host.close();
  }
};

const kinds = (events: RemoteAuditEvent[]): string[] => events.map((event) => event.event);

test('a stream over the pairing limit is refused with REMOTE_QUOTA and one audit row; the older streams keep running; the slot is freed on close', async () => {
  await withBridge(
    async ({ bridge, loop, events, quota }) => {
      const first = startHttpCall(loop, { path: '/api/projects/silent' });
      const second = startHttpCall(loop, { path: '/api/projects/silent' });
      await waitFor(() => bridge.activeStreams === 2, 'two active streams');

      const refused = await callThroughBridge(loop, { path: '/api/projects' });
      assert.equal(errorCode(refused.end), 'REMOTE_QUOTA');
      assert.deepEqual(kinds(events), ['quota-reject']);
      assert.equal(events[0].result, 'refused');
      assert.equal(events[0].target, 'GET /api/projects');
      assert.deepEqual(events[0].detail, { reason: 'streams', kind: 'http' });
      assert.equal(bridge.activeStreams, 2, 'the refused stream never became active');
      assert.ok(!first.stream.closed && !second.stream.closed, 'the streams already running are untouched');

      first.stream.cancel();
      await waitFor(() => quota.active.streams === 1, 'the slot of the cancelled stream to be freed');
      const served = await callThroughBridge(loop, { path: '/api/projects' });
      assert.equal(served.response?.status, 200);
      assert.deepEqual(kinds(events), ['quota-reject'], 'an admitted stream adds no quota row');
    },
    { maxStreams: 2 },
  );
});

test('every refusal is one audit row, and more than the violation limit per minute calls the disconnect hook once', async () => {
  await withBridge(
    async ({ loop, events, limitTrips }) => {
      startHttpCall(loop, { path: '/api/projects/silent' });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const outcome = await callThroughBridge(loop, { path: '/api/projects' });
        assert.equal(errorCode(outcome.end), 'REMOTE_QUOTA');
      }
      assert.equal(events.filter((event) => event.event === 'quota-reject').length, 4);
      assert.equal(limitTrips(), 1, 'the 4th refusal is past the limit of 3 per minute');
    },
    { maxStreams: 1, violationsPerMinute: 3 },
  );
});

test('the 2nd terminal is refused when only one PTY is allowed; PTY open and close are audited', async () => {
  await withBridge(
    async ({ loop, events, quota }) => {
      const terminal = startWsCall(loop, '/shell');
      await waitFor(() => quota.active.pty === 1, 'the terminal slot');
      assert.deepEqual(events.map((event) => `${event.event}:${event.target}`), ['pty-open:/shell']);

      const refused = startWsCall(loop, '/shell');
      assert.equal(errorCode(await refused.waitForEnd()), 'REMOTE_QUOTA');
      assert.deepEqual(events.at(-1)?.detail, { reason: 'pty', kind: 'pty' });

      terminal.stream.closeWebSocket(1000, 'bye');
      await waitFor(() => quota.active.pty === 0, 'the terminal slot to be freed');
      const close = events.find((event) => event.event === 'pty-close');
      assert.ok(close);
      assert.equal(close.target, '/shell');
      assert.ok(typeof close.detail?.seconds === 'number');
    },
    { maxPty: 1 },
  );
});

test('a close the server caused (overload 1013) is told to the quota so the reconnect is not counted', async () => {
  const forgiven: string[] = [];
  const quota: PairingQuota = {
    ...createPairingQuota({ clock: createManualClock(0) }),
    noteServerClose: () => void forgiven.push('server-close'),
  } as PairingQuota;
  const host = await startFakeHost();
  const bridge = createHostBridge({ port: host.port, env: {}, issueToken: () => 't', evaluateHttp: syntheticPathPolicy, quota });
  const loop = createMuxLoopback();
  loop.host.handleIncoming = (stream, open) => bridge.handleStream(stream, open);
  try {
    const call = startWsCall(loop, '/ws');
    await waitFor(() => bridge.activeStreams === 1, 'the chat socket');
    // The Controller floods before the loopback socket is open: the bridge closes with 1013 (server-caused).
    const flood = Buffer.from(JSON.stringify({ type: 'chat.subscribe' }));
    for (let index = 0; index < 400 && !call.stream.closed; index += 1) call.stream.sendMessage(flood, false);
    await call.waitForEnd();
    await waitFor(() => bridge.activeStreams === 0, 'the flooded socket to be released');
    assert.deepEqual(forgiven, ['server-close']);
    // A peer-initiated close is not server-caused.
    const normal = startWsCall(loop, '/ws');
    await waitFor(() => bridge.activeStreams === 1, 'a second chat socket');
    normal.stream.closeWebSocket(1000, 'bye');
    await normal.waitForEnd();
    await waitFor(() => bridge.activeStreams === 0, 'the second socket to be released');
    assert.deepEqual(forgiven, ['server-close'], 'a normal close is not forgiven');
  } finally {
    bridge.closeAll();
    await host.close();
  }
});

const json = (value: unknown) => {
  const text = JSON.stringify(value);
  return { headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: [text] };
};

test('file writes are audited with route, outcome and the target path, never the content; reads are not', async () => {
  await withBridge(async ({ loop, events }) => {
    const secret = 'FILE-CONTENT-THAT-MUST-NOT-BE-AUDITED';
    const write = await callThroughBridge(loop, {
      method: 'PUT',
      path: '/api/file-tree/projects/demo/file',
      ...json({ filePath: 'src/a.ts', content: secret }),
    });
    assert.equal(write.response?.status, 404, `the fake Host has no such route: the outcome is still audited (${JSON.stringify(write.end)})`);
    await callThroughBridge(loop, { method: 'GET', path: '/api/file-tree/projects/demo/files' });
    const writes = events.filter((event) => event.event === 'file-write');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, 'PUT /api/file-tree/projects/demo/file', 'the route, without a query');
    assert.equal(writes[0].result, 'error');
    assert.deepEqual(writes[0].detail, { status: 404, path: 'src/a.ts' }, 'the file that was written is named');
    assert.ok(!JSON.stringify(events).includes(secret), 'contents never');
  });
});

test('delete, rename and create name the file; a path given in the query is taken too; a long path is bounded before it is handed on', async () => {
  await withBridge(async ({ loop, events }) => {
    await callThroughBridge(loop, { method: 'DELETE', path: '/api/file-tree/projects/demo/files', ...json({ path: 'docs/old.md' }) });
    await callThroughBridge(loop, { method: 'PUT', path: '/api/file-tree/projects/demo/files/rename', ...json({ oldPath: 'a.txt', newName: 'b.txt' }) });
    await callThroughBridge(loop, { method: 'POST', path: '/api/file-tree/projects/demo/files/create', ...json({ path: 'src', name: 'new.ts', type: 'file' }) });
    await callThroughBridge(loop, { method: 'PUT', path: '/api/file-tree/projects/demo/file?filePath=from-query.ts', ...json({ content: 'x' }) });
    await callThroughBridge(loop, { method: 'DELETE', path: '/api/file-tree/projects/demo/files', ...json({ path: `d/${'x'.repeat(5000)}` }) });
    const details = events.filter((event) => event.event === 'file-write').map((event) => event.detail);
    assert.deepEqual(details[0], { status: 404, path: 'docs/old.md' });
    assert.deepEqual(details[1], { status: 404, path: 'a.txt', to: 'b.txt' });
    assert.deepEqual(details[2], { status: 404, path: 'src', name: 'new.ts' });
    assert.deepEqual(details[3], { status: 404, path: 'from-query.ts' });
    assert.ok(String(details[4]?.path).length <= 1000, 'a hostile path is cut before it goes anywhere');
  });
});

test('git writes, a clone (with a note when a stored GitHub token is spent, never the token), skill writes and attachment uploads are audited too; reads are not', async () => {
  await withBridge(async ({ loop, events }) => {
    await callThroughBridge(loop, { method: 'POST', path: '/api/git/commit', ...json({ project: 'demo', message: 'wip: SECRET-COMMIT-MESSAGE', files: ['a.ts'] }) });
    await callThroughBridge(loop, { method: 'POST', path: '/api/git/checkout', ...json({ project: 'demo', branch: 'feature/x' }) });
    await callThroughBridge(loop, { method: 'GET', path: '/api/git/status?project=demo' });
    await callThroughBridge(loop, {
      method: 'POST',
      path: '/api/projects/clone',
      ...json({ githubUrl: 'https://github.com/acme/private.git', githubTokenId: 7, newGithubToken: 'ghp_NEWTOKEN0123456789abcdefghijkl', path: '/work' }),
    });
    await callThroughBridge(loop, { method: 'POST', path: '/api/providers/claude/skills', ...json({ name: 'my-skill', content: 'SKILL-BODY' }) });
    await callThroughBridge(loop, { method: 'DELETE', path: '/api/providers/claude/skills/my-skill' });
    await callThroughBridge(loop, { method: 'POST', path: '/api/assets/images', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '5' }, body: ['abcde'] });
    await callThroughBridge(loop, { method: 'GET', path: '/api/assets/files/readme.txt' });

    const rows = events.filter((event) => event.event === 'file-write' || event.event === 'host-write');
    assert.deepEqual(
      rows.map((event) => [event.event, event.target]),
      [
        ['host-write', 'POST /api/git/commit'],
        ['host-write', 'POST /api/git/checkout'],
        ['host-write', 'POST /api/projects/clone'],
        ['host-write', 'POST /api/providers/claude/skills'],
        ['host-write', 'DELETE /api/providers/claude/skills/my-skill'],
        ['file-write', 'POST /api/assets/images'],
      ],
    );
    assert.equal(rows[0].detail?.project, 'demo');
    assert.equal(rows[1].detail?.branch, 'feature/x');
    assert.equal(rows[2].detail?.url, 'https://github.com/acme/private.git');
    assert.equal(rows[2].detail?.githubTokenUsed, true, 'a stored GitHub token was spent');
    assert.equal(rows[2].detail?.tokenSupplied, true, 'a new token came with the request');
    assert.equal(rows[3].detail?.name, 'my-skill');
    const text = JSON.stringify(events);
    for (const never of ['SECRET-COMMIT-MESSAGE', 'ghp_NEWTOKEN', 'SKILL-BODY']) assert.ok(!text.includes(never), never);
  });
});

test('a kill through the bridge leaves one host-write row with the node and mode and the HTTP outcome; a monitor read leaves none', async () => {
  await withBridge(async ({ loop, events }) => {
    await callThroughBridge(loop, { method: 'POST', path: '/api/agent-monitor/kill', ...json({ sessionId: 's1', nodeId: 'orch:s1', mode: 'kill' }) });
    await callThroughBridge(loop, { method: 'GET', path: '/api/agent-monitor/snapshot' });
    const rows = events.filter((event) => event.event === 'host-write');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, 'POST /api/agent-monitor/kill');
    assert.equal(rows[0].result, 'error', 'the fake Host answers 404, which is an outcome the row reports');
    assert.deepEqual(rows[0].detail, { status: 404, node: 'orch:s1', mode: 'kill', session: 's1' });
  });
});

test('a flood of policy denials beyond the report rate limit is counted for the auto-disconnect', async () => {
  const forbidden = Array.from({ length: 8 }, () => ({ path: '/api/auth/logout-all' }));
  await withBridge(
    async ({ loop, limitTrips, quota }) => {
      for (const request of forbidden) {
        const outcome = await callThroughBridge(loop, request);
        assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN');
      }
      await waitFor(() => quota.active.streams === 0, 'the refused streams to release');
      assert.ok(limitTrips() >= 1, 'denials past the burst of 2 are suppressed from the audit and counted against the pairing instead');
    },
    { violationsPerMinute: 3 },
    { limits: { violationBurst: 2, violationsPerSecond: 0 } },
  );
});

test('every way a stream ends frees its quota slot: policy refusal, upstream refusal, broken Host, bridge.closeAll, link down', async () => {
  await withBridge(async ({ bridge, loop, quota }) => {
    const denied = await callThroughBridge(loop, { path: '/api/auth/logout-all' });
    assert.equal(errorCode(denied.end), 'REMOTE_FORBIDDEN');
    const forbidden = await callThroughBridge(loop, { path: '/api/projects/forbidden' });
    assert.equal(errorCode(forbidden.end), 'REMOTE_UPSTREAM_AUTH');
    await callThroughBridge(loop, { path: '/api/projects/break' });
    await waitFor(() => quota.active.streams === 0, 'refusals and a broken response to free their slots');

    startHttpCall(loop, { path: '/api/projects/silent' });
    startHttpCall(loop, { path: '/api/projects/silent' });
    startWsCall(loop, '/ws');
    startWsCall(loop, '/shell');
    await waitFor(() => quota.active.streams === 4 && quota.active.pty === 1 && quota.active.ws === 1, 'four admitted streams');
    bridge.closeAll();
    await waitFor(() => quota.active.streams === 0 && quota.active.pty === 0 && quota.active.ws === 0, 'closeAll to free every slot');

    startHttpCall(loop, { path: '/api/projects/silent' });
    startWsCall(loop, '/shell');
    startWsCall(loop, '/ws');
    await waitFor(() => quota.active.streams === 3, 'three admitted streams');
    loop.host.table.closeAll('peer-down');
    await waitFor(() => quota.active.streams === 0 && quota.active.pty === 0 && quota.active.ws === 0, 'a link-down to free every slot');
  });
});

/** The fake Host echoes every message, so a Controller message that looks like a Host card plays the Host's part. */
const echoCard = (loop: MuxLoopback, call: ReturnType<typeof startWsCall>, card: Record<string, unknown>): Promise<void> => {
  call.stream.sendMessage(Buffer.from(JSON.stringify({ type: 'chat.subscribe', ...card })), false);
  // The card has been seen by the bridge once its echo is back at the Controller (the bridge looks before it forwards).
  return waitFor(() => {
    loop.clock.advance(60);
    return call.messages.some((message) => {
      const text = message.payload.toString('utf8');
      return text.includes(`"requestId":"${String(card.requestId)}"`) && text.includes(`"kind":"${String(card.kind)}"`);
    });
  }, `the echo of ${String(card.kind)} ${String(card.requestId)}`);
};
const respond = (call: ReturnType<typeof startWsCall>, response: Record<string, unknown>): void => {
  call.stream.sendMessage(Buffer.from(JSON.stringify({ type: 'chat.permission-response', ...response })), false);
};

test('approval decisions are audited as the Host saw the request: tool, kind, allow/deny, command; both commands when changed', async () => {
  await withBridge(async ({ loop, events, host }) => {
    const call = startWsCall(loop, '/ws');
    await waitFor(() => host.wsConnections.length === 1, 'the Host socket');

    await echoCard(loop, call, { kind: 'permission_request', requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build --token hunter2hunter2' } });
    respond(call, { requestId: 'r1', allow: true, updatedInput: { command: 'rm -rf build/cache' }, rememberEntry: 'Bash(*)' });
    await echoCard(loop, call, { kind: 'permission_request', requestId: 'r2', toolName: 'Write', input: { file_path: '/work/a.ts', content: 'SECRET-FILE-BODY' } });
    respond(call, { requestId: 'r2', allow: false, message: 'no thanks, free text' });
    await echoCard(loop, call, { kind: 'permission_request', requestId: 'r3', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which one?' }] } });
    respond(call, { requestId: 'r3', allow: true, updatedInput: { answers: { 'Which one?': 'private answer' } } });
    await echoCard(loop, call, { kind: 'permission_request', requestId: 'r4', toolName: 'ExitPlanMode', input: { plan: 'step 1: do the secret thing' } });
    respond(call, { requestId: 'r4', allow: false });
    respond(call, { requestId: 'never-asked', allow: true });
    await waitFor(() => events.filter((event) => event.event === 'tool-decision').length === 5, 'five decisions');

    const decisions = events.filter((event) => event.event === 'tool-decision');
    assert.deepEqual(decisions.map((event) => [event.target, event.result, event.detail?.kind]), [
      ['Bash', 'allow', 'S1'],
      ['Write', 'deny', 'S1'],
      ['AskUserQuestion', 'allow', 'S2'],
      ['ExitPlanMode', 'deny', 'S3'],
      ['unknown', 'allow', 'S1'],
    ]);
    assert.equal(decisions[0].detail?.command, 'rm -rf build --token hunter2hunter2', 'raw here: the audit service masks it');
    assert.equal(decisions[0].detail?.updatedCommand, 'rm -rf build/cache');
    assert.equal(decisions[1].detail?.path, '/work/a.ts');
    assert.equal(decisions[4].detail?.known, false);
    const text = JSON.stringify(events);
    for (const content of ['SECRET-FILE-BODY', 'private answer', 'the secret thing', 'free text']) assert.ok(!text.includes(content), content);
    // The decisions still reached the Host untouched apart from rememberEntry.
    assert.ok(host.wsReceived.some((message) => message.data.toString('utf8').includes('"requestId":"r1"') && !message.data.toString('utf8').includes('rememberEntry')));
  });
});

test('a Host card answered at Local ("permission_resolved") is forgotten, and a throwing audit receiver never fails a stream', async () => {
  await withBridge(
    async ({ loop, host }) => {
      const call = startWsCall(loop, '/ws');
      await waitFor(() => host.wsConnections.length === 1, 'the Host socket');
      await echoCard(loop, call, { kind: 'permission_request', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
      await echoCard(loop, call, { kind: 'permission_resolved', requestId: 'r1' });
      respond(call, { requestId: 'r1', allow: true });
      const ok = await callThroughBridge(loop, { path: '/api/projects' });
      assert.equal(ok.response?.status, 200);
      assert.ok(!call.stream.closed, 'the chat socket survived the broken receiver');
    },
    {},
    {
      onAudit: () => {
        throw new Error('the audit database is gone');
      },
    },
  );
});
