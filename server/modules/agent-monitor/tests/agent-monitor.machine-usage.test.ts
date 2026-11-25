import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMachineUsageReader } from '../agent-monitor.machine-usage.js';

type Times = { user: number; nice: number; sys: number; idle: number; irq: number };
const core = (times: Partial<Times>) => ({ model: 'x', speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times } });

function scripted(frames: Array<Array<ReturnType<typeof core>>>) {
  let clock = 0;
  let index = 0;
  return {
    advance: (ms: number) => { clock += ms; },
    next: () => { index += 1; },
    reader: createMachineUsageReader({
      cpus: () => frames[Math.min(index, frames.length - 1)],
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 6 * 1024 ** 3,
      now: () => clock,
    }),
  };
}

test('memory is total minus free; CPU is null until there is an earlier reading to compare with', () => {
  const { reader } = scripted([[core({ user: 10, idle: 90 })]]);
  const first = reader.read();
  assert.equal(first.memoryTotalBytes, 16 * 1024 ** 3);
  assert.equal(first.memoryUsedBytes, 10 * 1024 ** 3);
  assert.equal(first.cpuPercent, null);
});

test('CPU% is the busy share of all cores between two readings (all cores busy = 100)', () => {
  // Two cores; between the readings core A ran 60 busy of 100 ticks and core B 20 busy of 100: (60 + 20) / 200 = 40%.
  const s = scripted([
    [core({ user: 10, idle: 90 }), core({ user: 10, idle: 90 })],
    [core({ user: 70, idle: 130 }), core({ user: 30, idle: 170 })],
  ]);
  s.reader.read();
  s.advance(2000);
  s.next();
  assert.equal(s.reader.read().cpuPercent, 40);
});

test('a reading taken less than a second after the last one repeats its CPU figure instead of measuring a sliver', () => {
  const s = scripted([
    [core({ user: 0, idle: 0 })],
    [core({ user: 50, idle: 50 })],
    [core({ user: 51, idle: 99 })],
  ]);
  s.reader.read();
  s.advance(2000);
  s.next();
  assert.equal(s.reader.read().cpuPercent, 50);
  s.advance(300);
  s.next();
  assert.equal(s.reader.read().cpuPercent, 50);
});
