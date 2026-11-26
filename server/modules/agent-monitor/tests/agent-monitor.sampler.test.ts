import assert from 'node:assert/strict';
import test from 'node:test';

import type { RawProcess } from '@/modules/process-control/index.js';

import { createResourceSampler, type SamplerTarget } from '../agent-monitor.sampler.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const proc = (pid: number, ppid: number, cpuSeconds: number, rssBytes = 1000): RawProcess => ({ pid, ppid, name: `p${pid}`, cpuSeconds, rssBytes });

const SERVER: SamplerTarget = { key: 'server', kind: 'server', label: 'Server', pid: 10, includeDescendants: false };
const SESSION: SamplerTarget = { key: 'session:a', kind: 'session', label: 'Session A', pid: 100, includeDescendants: true };
const EXTERNAL: SamplerTarget = { key: 'external:900', kind: 'external', label: 'Other', pid: 900, includeDescendants: true };

/** A sampler whose processes are scripted and whose clock is ours, driven by `tick()` so no timer is involved. */
function scripted(targets: SamplerTarget[], frames: RawProcess[][], cores = 2) {
  let clock = 0;
  let frame = 0;
  const sampler = createResourceSampler({
    cores, now: () => clock, historyPoints: 3,
    readProcesses: async () => frames[Math.min(frame++, frames.length - 1)],
    listTargets: async () => targets,
  });
  return { sampler, advance: (ms: number) => { clock += ms; } };
}

test('CPU% comes from two simulated samples and the headline counts the server and the app sessions, not external processes', async () => {
  const { sampler, advance } = scripted([SERVER, SESSION, EXTERNAL], [
    [proc(10, 1, 100), proc(100, 1, 10), proc(101, 100, 1), proc(900, 1, 50)],
    [proc(10, 1, 100.4), proc(100, 1, 11), proc(101, 100, 1.4), proc(900, 1, 51)],
  ]);

  await sampler.tick();
  assert.equal(sampler.state().total?.cpuPercent, null, 'the first sample has nothing to compare with');
  advance(2000);
  await sampler.tick();

  const state = sampler.state();
  const byKey = Object.fromEntries(state.rows.map((row) => [row.key, row.usage.cpuPercent]));
  // 2 s window, 2 cores: server 0.4 s -> 10%, session tree 1.4 s -> 35%, external 1.0 s -> 25%.
  assert.deepEqual(byKey, { server: 10, 'session:a': 35, 'external:900': 25 });
  assert.equal(state.total?.cpuPercent, 45);
  assert.equal(state.total?.rssBytes, 1000 + 2000, 'server (own pid) + session tree (two processes)');
});

test('CPU% divides by the time the processes were read, not by when the sample was requested', async () => {
  // Both reads report CPU for the same 4 s of real time even though the clock we hand the sampler says 2 s.
  const readings = [
    { takenAt: 10_000, processes: [proc(10, 1, 100)] },
    { takenAt: 14_000, processes: [proc(10, 1, 102)] },
  ];
  let clock = 0;
  let frame = 0;
  const sampler = createResourceSampler({
    cores: 1, now: () => clock,
    readProcesses: async () => readings[frame++],
    listTargets: async () => [SERVER],
  });
  await sampler.tick();
  clock += 2000;
  await sampler.tick();
  assert.equal(sampler.state().rows[0].usage.cpuPercent, 50, '2 CPU-seconds over 4 s of one core');
  assert.equal(sampler.state().lastSampleAt, 14_000);
});

test('a target whose process is gone disappears and takes its series with it', async () => {
  const { sampler, advance } = scripted([SERVER, SESSION], [
    [proc(10, 1, 1), proc(100, 1, 1)],
    [proc(10, 1, 1)],
  ]);
  await sampler.tick();
  assert.equal(sampler.state().rows.length, 2);
  advance(2000);
  await sampler.tick();
  assert.deepEqual(sampler.state().rows.map((row) => row.key), ['server']);
});

test('the history is a ring: only the newest points are kept', async () => {
  const frames = Array.from({ length: 6 }, (_, index) => [proc(10, 1, index)]);
  const { sampler, advance } = scripted([SERVER], frames);
  for (let index = 0; index < 6; index += 1) {
    await sampler.tick();
    advance(1000);
  }
  assert.equal(sampler.state().totalSeries.length, 3);
  assert.equal(sampler.state().rows[0].series.length, 3);
});

test('nothing is read until a screen touches the sampler', async () => {
  let reads = 0;
  const sampler = createResourceSampler({
    cores: 1, intervalMs: 5, leaseMs: 50,
    readProcesses: async () => { reads += 1; return [proc(10, 1, 1)]; },
    listTargets: async () => [SERVER],
  });
  await sleep(60);
  assert.equal(reads, 0);
  assert.equal(sampler.state().active, false);
  sampler.dispose();
});

test('while touched it samples repeatedly, and it stops by itself when the lease runs out', async () => {
  let reads = 0;
  const sampler = createResourceSampler({
    cores: 1, intervalMs: 5, leaseMs: 80,
    readProcesses: async () => { reads += 1; return [proc(10, 1, reads)]; },
    listTargets: async () => [SERVER],
  });

  sampler.touch();
  assert.equal(sampler.state().active, true);
  await sleep(40);
  sampler.touch(); // the screen's next poll renews the lease
  await sleep(40);
  assert.ok(reads >= 3, `expected repeated sampling, got ${reads}`);
  assert.equal(sampler.state().active, true);

  await sleep(200);
  const settled = reads;
  assert.equal(sampler.state().active, false, 'the loop ended');
  assert.equal(sampler.state().rows.length, 0, 'what it measured is dropped');
  await sleep(60);
  assert.equal(reads, settled, 'no reads after the lease expired');

  sampler.touch(); // a new viewer starts it again, from scratch
  await sleep(30);
  assert.ok(reads > settled);
  sampler.dispose();
});

test('samples never overlap even when the reader is slower than the interval', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const sampler = createResourceSampler({
    cores: 1, intervalMs: 1, leaseMs: 120,
    readProcesses: async () => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(25);
      inFlight -= 1;
      return [proc(10, 1, 1)];
    },
    listTargets: async () => [SERVER],
  });
  sampler.touch();
  await sleep(100);
  sampler.dispose();
  assert.ok(reads >= 2);
  assert.equal(maxInFlight, 1);
});

test('a sample that never answers is cut off at the timeout, the error is reported and the loop carries on', async () => {
  let reads = 0;
  let sawAbort = false;
  const sampler = createResourceSampler({
    cores: 1, intervalMs: 5, leaseMs: 300, timeoutMs: 20,
    readProcesses: (signal) => {
      reads += 1;
      signal.addEventListener('abort', () => { sawAbort = true; });
      return new Promise(() => { /* ignores the signal and never settles */ });
    },
    listTargets: async () => [SERVER],
  });
  sampler.touch();
  await sleep(120);
  assert.ok(reads >= 2, 'a stuck sample does not stop the next one');
  assert.equal(sawAbort, true, 'the reader was told to abort (that kills the child process)');
  assert.match(sampler.state().error ?? '', /timed out after 20 ms/);
  sampler.dispose();
});

test('a failing reader reports its error and keeps the last good numbers', async () => {
  let fail = false;
  let clock = 0;
  const sampler = createResourceSampler({
    cores: 1, now: () => clock,
    readProcesses: async () => { if (fail) throw new Error('powershell exploded'); return [proc(10, 1, 1)]; },
    listTargets: async () => [SERVER],
  });
  await sampler.tick();
  fail = true;
  clock += 2000;
  await sampler.tick();
  assert.equal(sampler.state().error, 'powershell exploded');
  assert.equal(sampler.state().rows.length, 1);
});

test('child groups of a session come from the latest sample: nothing before the first one, a CPU share from the second', async () => {
  const { sampler, advance } = scripted([SESSION], [
    [proc(100, 1, 10), proc(101, 100, 1), proc(102, 100, 1)],
    [proc(100, 1, 11), proc(101, 100, 1.8), proc(102, 100, 1)],
  ]);
  assert.deepEqual(sampler.childGroups(100), [], 'no sample yet');

  await sampler.tick();
  assert.deepEqual(sampler.childGroups(100).map((group) => [group.name, group.count, group.cpuPercent]), [['p101', 1, null], ['p102', 1, null]]);
  advance(2000);
  await sampler.tick();
  // p101 used 0.8 CPU-seconds in 2 s on 2 cores = 20%.
  assert.equal(sampler.childGroups(100).find((group) => group.name === 'p101')?.cpuPercent, 20);
  assert.deepEqual(sampler.childGroups(4242), [], 'a pid that is not in the sample');
});
test('tree usage of a session: nothing before the first sample, numbers only (no pid, no top), CPU share from the second', async () => {
  const { sampler, advance } = scripted([SESSION], [
    [proc(100, 1, 10, 500), proc(101, 100, 1, 200), proc(102, 100, 1, 300)],
    [proc(100, 1, 11, 500), proc(101, 100, 1.8, 200), proc(102, 100, 1, 300)],
  ]);
  assert.equal(sampler.treeUsage(100), null, 'no sample yet');

  await sampler.tick();
  assert.deepEqual(sampler.treeUsage(100), { cpuPercent: null, rssBytes: 1000, processCount: 3 });
  advance(2000);
  await sampler.tick();
  // 1.8 CPU-seconds in 2 s on 2 cores = 45%.
  assert.deepEqual(sampler.treeUsage(100), { cpuPercent: 45, rssBytes: 1000, processCount: 3 });
  assert.deepEqual(Object.keys(sampler.treeUsage(100) ?? {}).sort(), ['cpuPercent', 'processCount', 'rssBytes'], 'no pid, no top list');
  assert.equal(sampler.treeUsage(4242), null, 'a pid that is not in the sample');
});

test('tree usage reads the sample already taken: it never samples, and is gone once the lease lapses', async () => {
  let reads = 0;
  const sampler = createResourceSampler({
    cores: 1, intervalMs: 5, leaseMs: 30,
    readProcesses: async () => { reads += 1; return [proc(100, 1, reads), proc(101, 100, reads)]; },
    listTargets: async () => [SESSION],
  });
  assert.equal(sampler.treeUsage(100), null);
  await sleep(20);
  assert.equal(reads, 0, 'treeUsage does not sample');

  await sampler.tick();
  assert.equal(sampler.treeUsage(100)?.processCount, 2, 'a sample exists');

  sampler.touch();
  for (let attempt = 0; attempt < 200 && sampler.treeUsage(100) !== null; attempt += 1) await sleep(10);
  assert.equal(sampler.treeUsage(100), null, 'nobody watches any more');
  sampler.dispose();
});

test('child groups are dropped with the samples when the lease lapses, and asking for them never starts the sampler', async () => {
  let reads = 0;
  const sampler = createResourceSampler({
    cores: 1, intervalMs: 5, leaseMs: 30,
    readProcesses: async () => { reads += 1; return [proc(100, 1, reads), proc(101, 100, reads)]; },
    listTargets: async () => [SESSION],
  });
  assert.deepEqual(sampler.childGroups(100), []);
  await sleep(20);
  assert.equal(reads, 0, 'childGroups does not sample');

  await sampler.tick();
  assert.equal(sampler.childGroups(100).length, 1, 'a sample exists');

  // A touch starts the loop; once its short lease lapses the loop drops what it measured.
  sampler.touch();
  for (let attempt = 0; attempt < 200 && sampler.childGroups(100).length > 0; attempt += 1) await sleep(10);
  assert.deepEqual(sampler.childGroups(100), [], 'nobody watches any more');
  sampler.dispose();
});