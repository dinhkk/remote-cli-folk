import type { AgentMonitorProcessGroup, AgentMonitorResourceRow, AgentMonitorSessionUsage } from '@/shared/types.js';
import { describeChildGroups, measureTree, toSample, type ProcessReading, type ProcessSample, type RawProcess } from '@/modules/process-control/index.js';

/** A process tree the monitor measures: this server, a session the app runs, or a Claude process it does not run. */
export type SamplerTarget = {
  key: string;
  kind: AgentMonitorResourceRow['kind'];
  label: string;
  pid: number;
  /** Count the descendants of `pid` too (a session's tool processes); the server counts only itself. */
  includeDescendants: boolean;
};

type SamplerOptions = {
  /** Reads the process table; may return the bare list when it has no read time of its own (`now()` is used then). */
  readProcesses: (signal: AbortSignal) => Promise<ProcessReading | RawProcess[]>;
  listTargets: () => Promise<SamplerTarget[]>;
  cores: number;
  now?: () => number;
  /** Time between the end of one sample and the start of the next. */
  intervalMs?: number;
  /** How long one `touch()` keeps the sampler alive. The screen touches it on every poll, so closing it ends sampling within this. */
  leaseMs?: number;
  /** Longest one sample may take before its reader is aborted. */
  timeoutMs?: number;
  /** History kept per series (the ~60 minute ring: 1800 points at 2 s). */
  historyPoints?: number;
};

type SeriesPoint = { cpu: number | null; rss: number };

export type SamplerState = {
  /** True while the sampling loop is alive (some screen touched it within the lease). */
  active: boolean;
  lastSampleAt: number | null;
  error: string | null;
  rows: Array<Omit<AgentMonitorResourceRow, 'cpuSeries' | 'rssSeries'> & { series: SeriesPoint[] }>;
  total: { cpuPercent: number | null; rssBytes: number } | null;
  totalSeries: SeriesPoint[];
};

/**
 * CPU and memory sampler that runs only while somebody is looking.
 *
 * Nothing runs until `touch()` (the monitor screen's poll calls it). Each touch renews a short lease; the loop samples
 * every `intervalMs` while the lease is valid and ends by itself once it is not, dropping what it measured so the next
 * viewer never sees a delta spanning a long gap. Samples never overlap (the next one is scheduled after the previous
 * one ends) and each is aborted after `timeoutMs`, so a stuck PowerShell cannot pile up.
 */
export function createResourceSampler({
  readProcesses,
  listTargets,
  cores,
  now = Date.now,
  intervalMs = 2000,
  leaseMs = 8000,
  timeoutMs = 8000,
  historyPoints = 1800,
}: SamplerOptions) {
  let leaseUntil = 0;
  let looping = false;
  let disposed = false;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  // What the last sample saw, kept to compute the next one's CPU delta.
  let previous: ProcessSample | null = null;
  // The sample before `previous`: with it, the latest sample's child process groups get a CPU share too.
  let earlier: ProcessSample | null = null;
  let state: SamplerState = { active: false, lastSampleAt: null, error: null, rows: [], total: null, totalSeries: [] };
  const rowSeries = new Map<string, SeriesPoint[]>();

  const push = (series: SeriesPoint[], point: SeriesPoint) => {
    series.push(point);
    if (series.length > historyPoints) series.splice(0, series.length - historyPoints);
  };

  /** One sample: read the processes, measure every target, extend the series. Never throws. */
  async function tick(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const requestedAt = now();
      // The abort kills a well-behaved reader; the race also covers one that ignores the signal.
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      const [reading, targets] = await Promise.race([Promise.all([readProcesses(controller.signal), listTargets()]), timedOut]);
      const { takenAt, processes } = Array.isArray(reading) ? { takenAt: null, processes: reading } : reading;
      // The reader's own clock reading is when the processes were observed; CPU% divides by the time between two of those.
      const at = takenAt ?? requestedAt;
      const current = toSample(at, processes);

      const rows: SamplerState['rows'] = [];
      for (const target of targets) {
        const usage = measureTree(previous, current, target.pid, cores, target.includeDescendants);
        if (!usage) continue;
        const series = rowSeries.get(target.key) ?? [];
        rowSeries.set(target.key, series);
        push(series, { cpu: usage.cpuPercent, rss: usage.rssBytes });
        rows.push({ key: target.key, kind: target.kind, label: target.label, pid: target.pid, usage, series });
      }
      for (const key of [...rowSeries.keys()]) {
        if (!rows.some((row) => row.key === key)) rowSeries.delete(key);
      }

      // The headline numbers count what the app itself runs: this server plus its own sessions.
      const own = rows.filter((row) => row.kind !== 'external');
      const measured = own.filter((row) => row.usage.cpuPercent !== null);
      const total = {
        cpuPercent: measured.length > 0 ? Math.round(measured.reduce((sum, row) => sum + (row.usage.cpuPercent ?? 0), 0) * 100) / 100 : null,
        rssBytes: own.reduce((sum, row) => sum + row.usage.rssBytes, 0),
      };
      const totalSeries = state.totalSeries;
      push(totalSeries, { cpu: total.cpuPercent, rss: total.rssBytes });

      earlier = previous;
      previous = current;
      state = { ...state, lastSampleAt: at, error: null, rows, total, totalSeries };
    } catch (error) {
      // A failed or timed-out sample keeps the last good numbers and the previous sample; the next one retries.
      const aborted = controller.signal.aborted;
      state = { ...state, error: aborted ? `sample timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wake = resolve;
      sleepTimer = setTimeout(resolve, ms);
      sleepTimer.unref?.();
    });
  }

  async function loop(): Promise<void> {
    while (!disposed && now() < leaseUntil) {
      await tick();
      if (disposed || now() >= leaseUntil) break;
      await sleep(intervalMs);
    }
    looping = false;
    previous = null;
    earlier = null;
    rowSeries.clear();
    state = { active: false, lastSampleAt: null, error: null, rows: [], total: null, totalSeries: [] };
  }

  return {
    /** Called by every poll of the screen: keeps the sampler running for another lease. */
    touch(): void {
      if (disposed) return;
      leaseUntil = now() + leaseMs;
      if (!looping) {
        looping = true;
        state = { ...state, active: true };
        void loop();
      }
    },

    state(): SamplerState {
      return state;
    },

    /**
     * The child processes of `rootPid` (a session's Claude process) in the latest sample, grouped by name. Reads the
     * sample already taken: it never samples, never starts the loop, and is empty once the lease lapsed or before the
     * first sample.
     */
    childGroups(rootPid: number): AgentMonitorProcessGroup[] {
      return previous ? describeChildGroups(earlier, previous, rootPid, cores) : [];
    },

    /**
     * CPU, memory and process count of the whole tree under `rootPid` (the Claude process and everything it started) in the
     * latest sample, as numbers only: no pid and no process list leave here. Like `childGroups` it reads the sample already
     * taken: null before the first sample, once the lease lapsed, or when the pid is not in the sample.
     */
    treeUsage(rootPid: number): AgentMonitorSessionUsage | null {
      const usage = previous ? measureTree(earlier, previous, rootPid, cores) : null;
      return usage ? { cpuPercent: usage.cpuPercent, rssBytes: usage.rssBytes, processCount: usage.processCount } : null;
    },

    /** Runs one sample now, outside the loop (tests drive the sampler with this). */
    tick,

    /** Stops the loop at once and refuses further touches (server shutdown, tests). */
    dispose(): void {
      disposed = true;
      leaseUntil = 0;
      if (sleepTimer) clearTimeout(sleepTimer);
      wake?.();
    },

    historyPoints,
  };
}

export type ResourceSampler = ReturnType<typeof createResourceSampler>;
