import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runKillCommand } from '@/modules/process-control/index.js';

import { createClaudeProcessLifecycle } from '../list/claude/claude-process-lifecycle.js';

async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

const fixture = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.once('spawn', () => process.stdout.write(String(child.pid) + '\\n'));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

test('three replacements end a stubborn owned parent and its background child before resolving', { skip: process.platform !== 'linux' }, async () => {
  for (let iteration = 0; iteration < 3; iteration++) {
    const lifecycle = createClaudeProcessLifecycle({ listRoots: async () => [], graceMs: 20 });
    const child = lifecycle.spawn({ command: process.execPath, args: ['-e', fixture], env: {}, signal: new AbortController().signal });
    const [chunk] = await once(child.stdout, 'data');
    const descendant = Number(String(chunk).trim());
    assert.ok(child.pid && descendant);
    try {
      let asked = false;
      await lifecycle.stop(() => { asked = true; child.stdin.end(); });
      assert.equal(asked, true);
      assert.equal(await alive(child.pid), false);
      assert.equal(await alive(descendant), false);
    } finally {
      for (const pid of [child.pid, descendant]) if (await alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
});

test('a parent exiting cooperatively does not strand its captured descendants', { skip: process.platform !== 'linux' }, async () => {
  const lifecycle = createClaudeProcessLifecycle({ listRoots: async () => [], graceMs: 20 });
  const child = lifecycle.spawn({ command: process.execPath, args: ['-e', fixture], env: {}, signal: new AbortController().signal });
  const [chunk] = await once(child.stdout, 'data');
  const descendant = Number(String(chunk).trim());
  assert.ok(child.pid && descendant);
  try {
    await lifecycle.stop(() => { child.kill('SIGKILL'); });
    assert.equal(await alive(child.pid), false);
    assert.equal(await alive(descendant), false);
  } finally {
    for (const pid of [child.pid, descendant]) if (await alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('cleanup refuses a tree containing another registered session', { skip: process.platform !== 'linux' }, async () => {
  let descendant = 0;
  const lifecycle = createClaudeProcessLifecycle({ listRoots: async () => [{ pid: descendant }], graceMs: 20 });
  const child = lifecycle.spawn({ command: process.execPath, args: ['-e', fixture], env: {}, signal: new AbortController().signal });
  const [chunk] = await once(child.stdout, 'data');
  descendant = Number(String(chunk).trim());
  assert.ok(child.pid && descendant);
  try {
    await assert.rejects(lifecycle.stop(() => {}), /protected session/);
    assert.equal(await alive(child.pid), true);
    assert.equal(await alive(descendant), true);
  } finally {
    for (const pid of [child.pid, descendant]) if (await alive(pid)) process.kill(pid, 'SIGKILL');
  }
});


test('a failed kill retains ownership and a retry ends the original tree', { skip: process.platform !== 'linux' }, async () => {
  let deny = true;
  const lifecycle = createClaudeProcessLifecycle({ listRoots: async () => [], graceMs: 20,
    run: async (...args) => { if (deny) throw new Error('fixture denied'); await runKillCommand(...args); },
  });
  const child = lifecycle.spawn({ command: process.execPath, args: ['-e', fixture], env: {}, signal: new AbortController().signal });
  const [chunk] = await once(child.stdout, 'data');
  const descendant = Number(String(chunk).trim());
  assert.ok(child.pid && descendant);
  try {
    await assert.rejects(lifecycle.stop(() => {}), /still running/);
    assert.equal(await alive(child.pid), true);
    assert.equal(await alive(descendant), true);
    deny = false;
    await lifecycle.stop(() => {});
    assert.equal(await alive(child.pid), false);
    assert.equal(await alive(descendant), false);
  } finally {
    for (const pid of [child.pid, descendant]) if (await alive(pid)) process.kill(pid, 'SIGKILL');
  }
});
