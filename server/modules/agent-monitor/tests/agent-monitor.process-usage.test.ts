import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeChildGroups,
  MAX_PROCESS_GROUPS,
  measureTree,
  parsePosixPs,
  parsePsCpuTime,
  parseWindowsProcessJson,
  toSample,
  treePids,
  type RawProcess,
} from '@/modules/process-control/index.js';

const proc = (pid: number, ppid: number, cpuSeconds: number, rssMb: number, name = `p${pid}`): RawProcess =>
  ({ pid, ppid, name, cpuSeconds, rssBytes: rssMb * 1024 * 1024 });

/** claude (100) with a bash tool (101) and a node MCP server (102 -> 103); 200 is somebody else. */
const tree = (cpu: { c: number; b: number; m: number; n: number }, extra: RawProcess[] = []) => [
  proc(1, 0, 50, 10, 'system'),
  proc(100, 1, cpu.c, 300, 'claude'),
  proc(101, 100, cpu.b, 20, 'bash'),
  proc(102, 100, cpu.m, 80, 'node'),
  proc(103, 102, cpu.n, 40, 'node'),
  proc(200, 1, 999, 500, 'other'),
  ...extra,
];

test('the tree is the root plus every descendant and nothing else', () => {
  const sample = toSample(0, tree({ c: 0, b: 0, m: 0, n: 0 }));
  assert.deepEqual(treePids(sample, 100).sort((a, b) => a - b), [100, 101, 102, 103]);
  assert.deepEqual(treePids(sample, 100, false), [100]);
  assert.deepEqual(treePids(sample, 4242), [], 'a root that is not running has no tree');
});

test('a parent cycle in the data cannot hang the walk', () => {
  const sample = toSample(0, [proc(1, 2, 0, 1), proc(2, 1, 0, 1), proc(3, 3, 0, 1)]);
  assert.deepEqual(treePids(sample, 1).sort(), [1, 2]);
  assert.deepEqual(treePids(sample, 3), [3]);
});

test('CPU% is the tree\'s CPU seconds between two samples over elapsed time over cores, memory is the summed working set', () => {
  const first = toSample(10_000, tree({ c: 10, b: 1, m: 5, n: 2 }));
  // 2 s later on a 4-core machine: claude +1.0 s, bash +0.2 s, mcp +0.4 s, its child +0.2 s = 1.8 s of CPU.
  const second = toSample(12_000, tree({ c: 11, b: 1.2, m: 5.4, n: 2.2 }));

  const usage = measureTree(first, second, 100, 4);
  assert.ok(usage);
  // 1.8 CPU-seconds / 2 s = 90% of one core = 22.5% of four cores.
  assert.equal(usage.cpuPercent, 22.5);
  assert.equal(usage.processCount, 4);
  assert.equal(usage.rssBytes, (300 + 20 + 80 + 40) * 1024 * 1024);
  assert.deepEqual(usage.top.map((entry) => [entry.name, entry.cpuPercent]), [['claude', 12.5], ['node', 5], ['node', 2.5], ['bash', 2.5]]);
});

test('there is no CPU% from one sample, only memory', () => {
  const usage = measureTree(null, toSample(0, tree({ c: 10, b: 1, m: 5, n: 2 })), 100, 4);
  assert.equal(usage?.cpuPercent, null);
  assert.equal(usage?.rssBytes, (300 + 20 + 80 + 40) * 1024 * 1024);
});

test('a child started between the samples counts all its CPU time; a pid that merely looks new does not', () => {
  const first = toSample(0, tree({ c: 10, b: 1, m: 5, n: 2 }));
  const second = toSample(2000, tree({ c: 10, b: 1, m: 5, n: 2 }, [proc(104, 100, 1, 5, 'new-child'), proc(105, 100, 3600, 5, 'reused-pid')]));
  const usage = measureTree(first, second, 100, 1);
  // new-child: 1 s in a 2 s window = 50%; reused-pid claims 3600 s of CPU in 2 s, which cannot be, so it adds 0.
  assert.equal(usage?.cpuPercent, 50);
});

test('a process whose CPU counter went backwards (pid reuse) adds nothing instead of a negative', () => {
  const first = toSample(0, tree({ c: 10, b: 1, m: 5, n: 2 }));
  const second = toSample(2000, tree({ c: 9, b: 1, m: 5, n: 2 }));
  assert.equal(measureTree(first, second, 100, 2)?.cpuPercent, 0);
});

test('a root that has exited has no usage', () => {
  const first = toSample(0, tree({ c: 10, b: 1, m: 5, n: 2 }));
  assert.equal(measureTree(first, toSample(2000, [proc(1, 0, 50, 10)]), 100, 2), null);
});

test('the heaviest five processes are listed by memory', () => {
  const many = Array.from({ length: 8 }, (_, index) => proc(300 + index, 100, 0, 10 + index));
  const usage = measureTree(null, toSample(0, tree({ c: 0, b: 0, m: 0, n: 0 }, many)), 100, 2);
  assert.equal(usage?.top.length, 5);
  assert.equal(usage?.top[0].name, 'claude');
  assert.equal(usage?.top[1].rssBytes, 80 * 1024 * 1024);
});

test('the Windows reader output parses, including a lone object and rubbish rows', () => {
  const { takenAt, processes: rows } = parseWindowsProcessJson('{"t":1700000000123,"list":[{"pid":4,"ppid":0,"name":"System","cpu":1.5,"rss":1000},{"pid":0,"ppid":0},"x",{"pid":9,"name":7}]}');
  assert.equal(takenAt, 1_700_000_000_123, 'the time the reader observed the processes');
  assert.deepEqual(rows.map((row) => [row.pid, row.name, row.cpuSeconds, row.rssBytes]), [[4, 'System', 1.5, 1000], [9, '', 0, 0]]);
  assert.equal(parseWindowsProcessJson('{"t":1,"list":{"pid":5,"ppid":4,"name":"a","cpu":2,"rss":3}}').processes.length, 1, 'a lone object');
  assert.equal(parseWindowsProcessJson('[{"pid":5,"ppid":4}]').takenAt, null, 'a bare list has no read time');
  assert.deepEqual(parseWindowsProcessJson('  '), { takenAt: null, processes: [] });
  assert.throws(() => parseWindowsProcessJson('not json'));
});

test('ps output parses: rss in KiB, cpu time in its two formats, command names with spaces', () => {
  const text = [
    '    1     0   9000     00:00:03 systemd',
    ' 4242  1000 204800  1-02:03:04 /opt/Google Chrome/chrome helper',
    ' 7000  4242    512     12:34.56 bash',
    'garbage line',
  ].join('\n');
  const rows = parsePosixPs(text);
  assert.deepEqual(rows.map((row) => [row.pid, row.ppid, row.rssBytes, row.cpuSeconds, row.name]), [
    [1, 0, 9000 * 1024, 3, 'systemd'],
    [4242, 1000, 204800 * 1024, 86_400 + 2 * 3600 + 3 * 60 + 4, 'chrome helper'],
    [7000, 4242, 512 * 1024, 12 * 60 + 34.56, 'bash'],
  ]);
  assert.equal(parsePsCpuTime('nonsense'), 0);
});

test('child groups: descendants only, grouped by name, heaviest memory first, with count, memory and CPU', () => {
  const first = toSample(0, tree({ c: 10, b: 1, m: 5, n: 2 }));
  const second = toSample(2000, tree({ c: 11, b: 1.2, m: 5.4, n: 2.2 }));
  const groups = describeChildGroups(first, second, 100, 4);
  // `claude` (the root) and every process outside the tree are left out; the two node processes are one group.
  assert.deepEqual(groups, [
    { name: 'node', count: 2, rssBytes: (80 + 40) * 1024 * 1024, cpuPercent: 7.5 },
    { name: 'bash', count: 1, rssBytes: 20 * 1024 * 1024, cpuPercent: 2.5 },
  ]);
});

test('child groups: no CPU before a second sample, nothing for a root without children or a root that is gone', () => {
  const only = toSample(0, tree({ c: 10, b: 1, m: 5, n: 2 }));
  assert.deepEqual(describeChildGroups(null, only, 100, 4).map((group) => group.cpuPercent), [null, null]);
  assert.deepEqual(describeChildGroups(null, only, 103, 4), [], 'a leaf process has no children');
  assert.deepEqual(describeChildGroups(null, only, 4242, 4), [], 'a root that is not running');
});

test('child groups: names are grouped without regard to case, trimmed and capped in length; a blank name reads "unknown"', () => {
  const sample = toSample(0, [
    proc(1, 0, 0, 1, 'root'),
    proc(2, 1, 0, 10, 'Node'),
    proc(3, 1, 0, 20, 'node'),
    proc(4, 1, 0, 5, '  '),
    proc(5, 1, 0, 1, 'x'.repeat(200)),
  ]);
  const groups = describeChildGroups(null, sample, 1, 2);
  assert.deepEqual(groups.map((group) => [group.name, group.count]), [['Node', 2], ['unknown', 1], ['x'.repeat(48), 1]]);
});

test('child groups: past the cap the lightest groups are summed into one unnamed "other" group', () => {
  const kids = Array.from({ length: MAX_PROCESS_GROUPS + 3 }, (_, index) => proc(10 + index, 1, 0, 100 - index, `tool${index}`));
  const groups = describeChildGroups(null, toSample(0, [proc(1, 0, 0, 1, 'root'), ...kids]), 1, 2);
  assert.equal(groups.length, MAX_PROCESS_GROUPS);
  assert.deepEqual(groups.slice(0, MAX_PROCESS_GROUPS - 1).map((group) => group.name), kids.slice(0, MAX_PROCESS_GROUPS - 1).map((kid) => kid.name));
  const other = groups[groups.length - 1];
  const rest = kids.slice(MAX_PROCESS_GROUPS - 1);
  assert.equal(other.name, '');
  assert.equal(other.count, rest.length);
  assert.equal(other.rssBytes, rest.reduce((sum, kid) => sum + kid.rssBytes, 0));
});

test('child groups leak nothing but name, count, memory and CPU, even if the process records carry more', () => {
  const noisy = { ...proc(2, 1, 0, 10, 'node'), commandLine: 'node --token=secret C:\\Users\\me\\app.js', exe: 'C:\\secret\\node.exe', env: { KEY: 'x' } } as RawProcess;
  const groups = describeChildGroups(null, toSample(0, [proc(1, 0, 0, 1, 'root'), noisy]), 1, 2);
  assert.deepEqual(Object.keys(groups[0]).sort(), ['count', 'cpuPercent', 'name', 'rssBytes']);
  assert.equal(JSON.stringify(groups).includes('secret'), false);
});