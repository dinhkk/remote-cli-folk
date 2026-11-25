import os from 'node:os';

import type { AgentMonitorMachineUsage } from '@/shared/types.js';

type CpuInfo = { times: { user: number; nice: number; sys: number; idle: number; irq: number } };

type MachineUsageOptions = {
  cpus?: () => CpuInfo[];
  totalmem?: () => number;
  freemem?: () => number;
  now?: () => number;
};

/** A reading closer than this to the last one repeats its CPU figure: a few ticks of CPU time are mostly noise. */
const MIN_CPU_WINDOW_MS = 1000;

const sumTimes = (cpus: CpuInfo[]): { busy: number; total: number } => {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
};

/**
 * The whole machine's CPU and memory, not a process's: memory is total minus what the OS reports free; CPU% is the busy
 * share of every core's time between two readings (all cores busy = 100, the scale Task Manager uses). The CPU figure is
 * null until there is an earlier reading. Stateful, so one reader serves every poll: a second poll within a second gets
 * the figure of the first instead of measuring a sliver of time.
 */
export function createMachineUsageReader({ cpus = os.cpus, totalmem = os.totalmem, freemem = os.freemem, now = Date.now }: MachineUsageOptions = {}) {
  let previous: { at: number; busy: number; total: number } | null = null;
  let cpuPercent: number | null = null;

  return {
    read(): AgentMonitorMachineUsage {
      const at = now();
      if (!previous || at - previous.at >= MIN_CPU_WINDOW_MS) {
        const current = sumTimes(cpus());
        if (previous && current.total > previous.total) {
          const share = ((current.busy - previous.busy) / (current.total - previous.total)) * 100;
          cpuPercent = Math.round(Math.min(100, Math.max(0, share)) * 100) / 100;
        }
        previous = { at, ...current };
      }
      const memoryTotalBytes = totalmem();
      return { cpuPercent, memoryUsedBytes: Math.max(0, memoryTotalBytes - freemem()), memoryTotalBytes };
    },
  };
}

export type MachineUsageReader = ReturnType<typeof createMachineUsageReader>;
