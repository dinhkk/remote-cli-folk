import assert from 'node:assert/strict';
import test from 'node:test';

import { groupKeyOf, parsePosixPs, parseWindowsProcessJson, toSample, type ProcessReading, type RawProcess } from '../agent-monitor.process-usage.js';
import {
  createProcessKiller,
  killInvocations,
  MAX_KILL_PIDS,
  protectedSet,
  selectGroupPids,
  START_TIME_EPSILON_MS,
  verifyClaudeRoot,
  type KillRun,
} from '../agent-monitor.process-kill.js';

const T0 = 1_700_000_000_000;
const proc = (pid: number, ppid: number, name: string, startedAt: number | null = T0): RawProcess => ({ pid, ppid, name, cpuSeconds: 0, rssBytes: 1, startedAt });

/**
 * 1 system; 10 = the app server (node); 100 = claude of THIS chat, a child of the server, with node MCP servers 101, 102 and
 * a bash tool 103; 300 = claude of another chat (also under the server) with its own node 301.
 */
const world = (): RawProcess[] => [
  proc(1, 0, 'System'),
  proc(10, 1, 'node'),
  proc(100, 10, 'claude'),
  proc(101, 100, 'node'),
  proc(102, 100, 'Node'),
  proc(103, 100, 'bash'),
  proc(300, 10, 'claude'),
  proc(301, 300, 'node'),
  proc(500, 1, 'node'),
];
const sampleOf = (processes: RawProcess[]) => toSample(T0 + 60_000, processes);

test('groupKeyOf trims, cuts at 48 and lower-cases, and an empty name is `unknown`', () => {
  assert.equal(groupKeyOf('  Node '), 'node');
  assert.equal(groupKeyOf('x'.repeat(60)), 'x'.repeat(48));
  assert.equal(groupKeyOf('   '), 'unknown');
});

test('a reading carries the start time: Windows `st`, POSIX `etime`', () => {
  const windows = parseWindowsProcessJson(JSON.stringify({ t: 1, list: [{ pid: 5, ppid: 1, name: 'a', cpu: 0, rss: 1, st: 1234 }, { pid: 6, ppid: 1, name: 'b', cpu: 0, rss: 1 }] }));
  assert.deepEqual(windows.processes.map((entry) => entry.startedAt), [1234, null]);
  const posix = parsePosixPs('  7   1  2048  00:00:01  01:02:03 claude\n  8   1  10  00:00:00  05-00:00:10 Google Chrome\n  9   1  10  00:00:00 old-format-name', 10_000_000);
  assert.deepEqual(posix.map((entry) => [entry.name, entry.startedAt]), [['claude', 10_000_000 - 3_723_000], ['Google Chrome', 10_000_000 - (5 * 86_400 + 10) * 1000], ['old-format-name', null]]);
});

test('a group is the descendants of the root with that name, never the root, the protected or a reused pid\'s orphan', () => {
  const sample = sampleOf(world());
  assert.deepEqual(selectGroupPids(sample, 100, 'node', new Set()).sort(), [101, 102], 'Node and node are one group');
  assert.deepEqual(selectGroupPids(sample, 100, 'claude', new Set()), [], 'the root is not in its own group');
  assert.deepEqual(selectGroupPids(sample, 100, 'node', new Set([102])), [101]);
  assert.deepEqual(selectGroupPids(sample, 100, 'unknown', new Set()), []);
  assert.deepEqual(selectGroupPids(sample, 100, '', new Set()), [], 'an empty name selects nothing');
  assert.deepEqual(selectGroupPids(sample, 999, 'node', new Set()), [], 'a root that is not running');

  const orphan = sampleOf([...world().filter((entry) => entry.pid !== 101), proc(101, 100, 'node', T0 - 3_600_000)]);
  assert.deepEqual(selectGroupPids(orphan, 100, 'node', new Set()), [102], 'a child that started before its parent only looks like one (the parent pid was reused)');
});

test('the protected set: the server, its ancestors, other claude trees, but not the tree being killed', () => {
  const sample = sampleOf(world());
  const guard = protectedSet(sample, 10, [100, 300], 100);
  assert.ok(guard.has(10) && guard.has(1), 'the server and its ancestor');
  assert.ok(guard.has(300) && guard.has(301), 'another chat\'s whole tree');
  assert.ok(guard.has(500) === false, 'a stranger outside every tree is not "protected": it is simply not selected');
  for (const pid of [100, 101, 102, 103]) assert.ok(!guard.has(pid), `${pid} belongs to the tree being killed`);

  const cyclic = sampleOf([proc(1, 2, 'a'), proc(2, 1, 'b')]);
  assert.doesNotThrow(() => protectedSet(cyclic, 1, [], 2));
});

test('only a claude image started when the registry says is a root; a missing start time is refused', () => {
  const entry = proc(100, 10, 'claude', T0);
  assert.equal(verifyClaudeRoot(entry, T0 + 1_800, 'win32'), 'ok');
  assert.equal(verifyClaudeRoot(entry, T0 - START_TIME_EPSILON_MS, 'win32'), 'ok');
  assert.equal(verifyClaudeRoot(entry, T0 + START_TIME_EPSILON_MS + 1, 'win32'), 'refused', 'started far from the registry: a reused pid');
  assert.equal(verifyClaudeRoot(proc(100, 10, 'node', T0), T0, 'win32'), 'refused', 'wrong image on Windows');
  assert.equal(verifyClaudeRoot(proc(100, 10, 'node', T0), T0, 'linux'), 'ok', 'POSIX also allows node and bun');
  assert.equal(verifyClaudeRoot(proc(100, 10, 'zsh', T0), T0, 'linux'), 'refused');
  assert.equal(verifyClaudeRoot(proc(100, 10, 'claude', null), T0, 'win32'), 'refused', 'no start time known');
  assert.equal(verifyClaudeRoot(entry, null, 'win32'), 'refused', 'no start time in the registry');
  assert.equal(verifyClaudeRoot(undefined, T0, 'win32'), 'refused');
});

test('kill commands: no shell, taskkill by absolute path, integer pids only, POSIX root before children', () => {
  assert.deepEqual(killInvocations('win32', [100], { tree: true }, 'C:\\Windows'), [{ command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '100', '/T', '/F'] }]);
  assert.deepEqual(killInvocations('win32', [101, 102], { tree: false }, 'C:\\Windows').map((entry) => entry.args), [['/PID', '101', '/F'], ['/PID', '102', '/F']]);
  assert.deepEqual(killInvocations('linux', [100, 101, 103], { tree: true }), [
    { command: 'kill', args: ['-KILL', '100'] },
    { command: 'kill', args: ['-KILL', '101'] },
    { command: 'kill', args: ['-KILL', '103'] },
  ]);
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) assert.throws(() => killInvocations('win32', [bad], { tree: true }, 'C:\\Windows'), /pid/);
});

/** A fake machine: the process table, and a `run` that really removes the pids the command names (unless told to fail). */
function fakeMachine(initial: RawProcess[], { failKills = false, readFails = false, readsFailAfterKill = false }: { failKills?: boolean; readFails?: boolean; readsFailAfterKill?: boolean } = {}) {
  let table = [...initial];
  const calls: Array<{ command: string; args: string[] }> = [];
  let killed = false;
  const readProcesses = async (): Promise<ProcessReading> => {
    if (readFails || (readsFailAfterKill && killed)) throw new Error('read failed');
    return { takenAt: T0 + 60_000, processes: table };
  };
  const run: KillRun = async (command, args) => {
    calls.push({ command, args });
    killed = true;
    if (!failKills) {
      const pid = Number(args[args.indexOf('/PID') + 1]);
      const tree = args.includes('/T');
      const doomed = new Set<number>([pid]);
      if (tree) for (let changed = true; changed;) { changed = false; for (const entry of table) if (!doomed.has(entry.pid) && doomed.has(entry.ppid)) { doomed.add(entry.pid); changed = true; } }
      table = table.filter((entry) => !doomed.has(entry.pid));
    }
    // Whatever the exit code, the outcome is judged by the table: taskkill's 128 / 5 must not matter.
    throw Object.assign(new Error('exit 128'), { code: 128 });
  };
  return { calls, readProcesses, run, table: () => table };
}

const killerOver = (machine: ReturnType<typeof fakeMachine>) =>
  createProcessKiller({ readProcesses: machine.readProcesses, run: machine.run, serverPid: 10, platform: 'win32', systemRoot: 'C:\\Windows' });
const CTX = { registryStartedAt: T0 + 500, otherRoots: [300] };

test('killing a group removes exactly that group and reads the table again to say so', async () => {
  const machine = fakeMachine(world());
  const outcome = await killerOver(machine).killGroup(100, 'node', CTX);
  assert.deepEqual(outcome, { result: 'killed', count: 2 });
  assert.deepEqual(machine.table().map((entry) => entry.pid).sort((a, b) => a - b), [1, 10, 100, 103, 300, 301, 500]);
  assert.ok(machine.calls.every((call) => call.command.endsWith('taskkill.exe')));
});

test('a kill that fails is judged by the table, not by what the command said', async () => {
  const stubborn = fakeMachine(world(), { failKills: true });
  assert.equal((await killerOver(stubborn).killGroup(100, 'node', CTX)).result, 'error', 'the processes are still there');
  const unreadable = fakeMachine(world(), { readsFailAfterKill: true });
  assert.equal((await killerOver(unreadable).killGroup(100, 'node', CTX)).result, 'error', 'cannot confirm after the kill');
});

test('a group with no processes is gone and runs nothing; an unreadable table is unavailable', async () => {
  const machine = fakeMachine(world());
  assert.deepEqual(await killerOver(machine).killGroup(100, 'python', CTX), { result: 'gone', count: 0 });
  assert.equal(machine.calls.length, 0);
  assert.equal((await killerOver(fakeMachine(world(), { readFails: true })).killGroup(100, 'node', CTX)).result, 'unavailable');
});

test('a group is refused for an empty or unknown name, a wrong root and a root that is the server', async () => {
  const machine = fakeMachine(world());
  const killer = killerOver(machine);
  assert.equal((await killer.killGroup(100, '', CTX)).result, 'refused');
  assert.equal((await killer.killGroup(100, 'unknown', CTX)).result, 'refused');
  assert.equal((await killer.killGroup(100, 'node', { ...CTX, registryStartedAt: T0 + 3_600_000 })).result, 'refused', 'the pid was reused');
  assert.equal((await killer.killGroup(500, 'node', { ...CTX, registryStartedAt: T0 })).result, 'refused', 'not a claude image');
  assert.equal((await killer.killGroup(10, 'node', { ...CTX, registryStartedAt: T0 })).result, 'refused', 'the server');
  assert.equal(machine.calls.length, 0);
});

test('a group never takes the server, its ancestors or another chat with it', async () => {
  // The server's own helper is also called node and sits under the claude root in this odd tree.
  const odd = [...world(), proc(900, 100, 'node'), proc(901, 300, 'node')];
  const machine = fakeMachine(odd);
  const outcome = await killerOver(machine).killGroup(100, 'node', CTX);
  assert.equal(outcome.result, 'killed');
  assert.ok(machine.table().some((entry) => entry.pid === 301 && entry.ppid === 300), 'the other chat is untouched');
  assert.ok(machine.table().some((entry) => entry.pid === 901), 'the other chat is untouched');
});

test('a tree kill takes the whole claude tree and verifies the root first', async () => {
  const machine = fakeMachine(world());
  const outcome = await killerOver(machine).killTree(100, CTX);
  assert.equal(outcome.result, 'killed');
  assert.deepEqual(machine.table().map((entry) => entry.pid).sort((a, b) => a - b), [1, 10, 300, 301, 500]);
  assert.equal(machine.calls.length, 1);
  assert.deepEqual(machine.calls[0].args, ['/PID', '100', '/T', '/F']);
});

test('a tree kill is refused for a reused pid, the server, a server ancestor, a tree holding another claude, a missing start time', async () => {
  const machine = fakeMachine(world());
  const killer = killerOver(machine);
  assert.equal((await killer.killTree(100, { ...CTX, registryStartedAt: T0 + 3_600_000 })).result, 'refused');
  assert.equal((await killer.killTree(100, { ...CTX, registryStartedAt: null })).result, 'refused');
  assert.equal((await killer.killTree(10, { ...CTX, registryStartedAt: T0 })).result, 'refused', 'the server itself');
  assert.equal((await killer.killTree(500, { ...CTX, registryStartedAt: T0 })).result, 'refused', 'not a claude image');

  // A terminal claude (400) that started the server: killing it would kill the server, so it is refused.
  const ancestor = fakeMachine([proc(1, 0, 'System'), proc(400, 1, 'claude'), proc(10, 400, 'node'), proc(100, 10, 'claude')]);
  assert.equal((await killerOver(ancestor).killTree(400, { registryStartedAt: T0, otherRoots: [] })).result, 'refused');
  // A claude that holds another chat's claude in its tree.
  const nested = fakeMachine([proc(1, 0, 'System'), proc(10, 1, 'node'), proc(400, 1, 'claude'), proc(300, 400, 'claude')]);
  assert.equal((await killerOver(nested).killTree(400, { registryStartedAt: T0, otherRoots: [300] })).result, 'refused');
  assert.equal(machine.calls.length + ancestor.calls.length + nested.calls.length, 0, 'nothing was run for any refusal');
});

test('a tree kill of a root that is gone says so; one that survives is an error', async () => {
  assert.equal((await killerOver(fakeMachine([proc(1, 0, 'System')])).killTree(100, CTX)).result, 'gone');
  assert.equal((await killerOver(fakeMachine(world(), { failKills: true })).killTree(100, CTX)).result, 'error');
});

test('POSIX kills the root first, then its children, one by one', async () => {
  const table = world();
  const machine = fakeMachine(table);
  const calls: string[][] = [];
  const posix = createProcessKiller({
    readProcesses: machine.readProcesses,
    run: async (command, args) => { calls.push([command, ...args]); },
    serverPid: 10,
    platform: 'linux',
  });
  await posix.killTree(100, CTX);
  assert.deepEqual(calls[0], ['kill', '-KILL', '100']);
  assert.deepEqual(calls.slice(1).map((call) => call[2]).sort(), ['101', '102', '103']);
});

test('at most MAX_KILL_PIDS pids are sent in one go', async () => {
  const many = [proc(1, 0, 'System'), proc(10, 1, 'node'), proc(100, 10, 'claude'), ...Array.from({ length: MAX_KILL_PIDS + 20 }, (_, index) => proc(1000 + index, 100, 'node'))];
  const machine = fakeMachine(many);
  const outcome = await killerOver(machine).killGroup(100, 'node', CTX);
  assert.equal(machine.calls.length, MAX_KILL_PIDS);
  assert.equal(outcome.result, 'error', 'some are left, so the kill is not complete');
});

function posixKiller(table: RawProcess[], { immortal = [] as number[] } = {}) {
  let live = [...table];
  const order: number[] = [];
  const killer = createProcessKiller({
    readProcesses: async () => ({ takenAt: T0 + 60_000, processes: live }),
    run: async (_command, args) => {
      const pid = Number(args[1]);
      order.push(pid);
      if (!immortal.includes(pid)) live = live.filter((entry) => entry.pid !== pid);
    },
    serverPid: 10,
    platform: 'linux',
  });
  return { killer, order, table: () => live };
}

test('POSIX tree kill takes a tree larger than MAX_KILL_PIDS down completely, root first', async () => {
  const children = Array.from({ length: MAX_KILL_PIDS + 20 }, (_, index) => proc(1000 + index, 100, 'node'));
  const machine = posixKiller([proc(1, 0, 'System'), proc(10, 1, 'node'), proc(100, 10, 'claude'), ...children]);
  const outcome = await machine.killer.killTree(100, CTX);
  assert.deepEqual(outcome, { result: 'killed', count: children.length + 1 });
  assert.equal(machine.order[0], 100);
  assert.deepEqual(machine.table().map((entry) => entry.pid), [1, 10]);
});

test('POSIX tree kill reports an error when a descendant survives even though the root is gone', async () => {
  const machine = posixKiller(world(), { immortal: [103] });
  const outcome = await machine.killer.killTree(100, CTX);
  assert.equal(outcome.result, 'error');
  assert.ok(machine.table().some((entry) => entry.pid === 103));
  assert.ok(!machine.table().some((entry) => entry.pid === 100));
});
