import type { AgentMonitorResourceRow, AgentMonitorSession, AgentMonitorSnapshot, AgentMonitorSummary } from '@/shared/types.js';

import type { AgentActivityAggregator } from './agent-monitor.aggregator.js';
import { createMachineUsageReader, type MachineUsageReader } from './agent-monitor.machine-usage.js';
import { groupSessionsByProject } from './agent-monitor.projects.js';
import type { ResourceSampler } from './agent-monitor.sampler.js';
import type { TerminalSessionReader } from './agent-monitor.terminal-sessions.js';
import { isLiveState } from './agent-monitor.visibility.js';

type ServiceOptions = {
  aggregator: AgentActivityAggregator;
  /** Sessions started outside the app (terminal); derived from the CLI's registry and transcripts. */
  terminal: TerminalSessionReader;
  sampler: ResourceSampler;
  cores: number;
  intervalMs: number;
  now?: () => number;
  /** Cache-read share (0..1) of a session's latest request, from its transcript; null when unknown. */
  readCacheHitRatio?: (sessionId: string) => Promise<number | null>;
  /** CPU and memory of the whole machine; the real OS reading unless a test supplies its own. */
  machine?: MachineUsageReader;
};

/** The sparklines cover this long. */
const SPARKLINE_WINDOW_MS = 60_000;
/** A session's cache-hit ratio is re-read at most this often (it reads a transcript tail). */
const CACHE_HIT_REFRESH_MS = 15_000;
/** Sessions listed at most: the app's chats and the terminal sessions together, busiest first. */
const MAX_SESSIONS_TOTAL = 40;

const KIND_ORDER: Record<AgentMonitorResourceRow['kind'], number> = { server: 0, session: 1, external: 2 };

/** Busiest first, then the most recently active. */
const byBusiness = (a: AgentMonitorSession, b: AgentMonitorSession): number =>
  Number(b.state !== 'idle') - Number(a.state !== 'idle') || b.lastEventAt - a.lastEventAt;

/**
 * Builds the monitor's answers from the event aggregator (chats started through the app), the terminal-session reader
 * (Claude processes the app did not start) and the resource sampler.
 *
 * Asking for a snapshot is also what keeps the sampler and the transcript reading alive (the open screen polls), so
 * closing the screen is all it takes to stop both. The summary never does: it reads memory and the small registry files.
 */
export function createAgentMonitorService({ aggregator, terminal, sampler, cores, intervalMs, now = Date.now, readCacheHitRatio, machine = createMachineUsageReader() }: ServiceOptions) {
  const cacheHitReadAt = new Map<string, number>();

  /** Refreshes the cache-hit ratio of the sessions in view in the background; a failure just leaves the old value. */
  function refreshCacheHitRatios(): void {
    if (!readCacheHitRatio) return;
    const at = now();
    for (const sessionId of aggregator.activeSessionIds()) {
      if (at - (cacheHitReadAt.get(sessionId) ?? 0) < CACHE_HIT_REFRESH_MS) continue;
      cacheHitReadAt.set(sessionId, at);
      readCacheHitRatio(sessionId).then((ratio) => aggregator.setCacheHitRatio(sessionId, ratio), () => undefined);
    }
  }

  /**
   * A terminal-derived entry for a chat the aggregator already draws is a duplicate: the event stream is the better source.
   * The exception is a chat the aggregator shows idle while the CLI says it is busy (the chat was resumed in a terminal).
   */
  const isDuplicate = (openSessionId: string | null, derivedIdle: boolean, drawn: ReadonlyMap<string, AgentMonitorSession>): boolean => {
    const known = openSessionId ? drawn.get(openSessionId) : undefined;
    return Boolean(known) && (known?.state !== 'idle' || derivedIdle);
  };

  return {
    snapshot(): AgentMonitorSnapshot {
      sampler.touch();
      terminal.touch();
      refreshCacheHitRatios();

      const activity = aggregator.tokenActivity(Math.ceil(SPARKLINE_WINDOW_MS / intervalMs), intervalMs);
      const drawn = aggregator.snapshot().sessions;
      const drawnById = new Map(drawn.map((session) => [session.id, session]));
      const resources = sampler.state();
      // The Claude pid of each chat the app runs: the sampler's session targets are keyed `session:<app session id>`.
      const appPids = new Map(resources.rows.filter((row) => row.kind === 'session').map((row) => [row.key, row.pid]));
      const withProcesses = (session: AgentMonitorSession): AgentMonitorSession => {
        const pid = terminal.pidOf(session.id) ?? appPids.get(`session:${session.id}`) ?? null;
        if (pid === null) return { ...session, processes: [] };
        const usage = sampler.treeUsage(pid);
        return { ...session, processes: sampler.childGroups(pid), ...(usage ? { usage } : {}) };
      };
      const sessions = [
        ...drawn,
        ...terminal.current().filter((session) => !isDuplicate(session.openSessionId, session.state === 'idle', drawnById)),
      ].sort(byBusiness).slice(0, MAX_SESSIONS_TOTAL).map(withProcesses);

      const points = Math.ceil(SPARKLINE_WINDOW_MS / intervalMs);

      const rows: AgentMonitorResourceRow[] = resources.rows
        .map(({ series, ...row }) => ({
          ...row,
          cpuSeries: series.slice(-points).map((point) => point.cpu),
          rssSeries: series.slice(-points).map((point) => point.rss),
        }))
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.usage.rssBytes - a.usage.rssBytes);

      return {
        generatedAt: now(),
        kpi: {
          runningAgents: sessions.reduce((sum, session) => sum + session.agents.filter((agent) => isLiveState(agent.state)).length, 0),
          runningSessions: sessions.filter((session) => session.state !== 'idle').length,
          tokensPerMinute: activity.perMinute,
          tokensToday: activity.today,
          cpuPercent: resources.total?.cpuPercent ?? null,
          rssBytes: resources.total?.rssBytes ?? null,
          tokenSeries: activity.series,
          cpuSeries: resources.totalSeries.slice(-points).map((point) => point.cpu),
          rssSeries: resources.totalSeries.slice(-points).map((point) => point.rss),
        },
        sessions,
        projects: groupSessionsByProject(sessions),
        resources: {
          sampling: resources.active,
          intervalMs,
          lastSampleAt: resources.lastSampleAt,
          error: resources.error,
          cores,
          machine: machine.read(),
          rows,
        },
      };
    },

    /**
     * The header badge's numbers. Cheap by design: the aggregator's memory plus the CLI's small registry files. It does
     * not touch the sampler or the transcript reader, so a closed screen costs a few file reads every few seconds.
     */
    async summary(): Promise<AgentMonitorSummary> {
      const drawn = aggregator.snapshot().sessions;
      const drawnById = new Map(drawn.map((session) => [session.id, session]));
      const running: Array<{ projectKey: string; waiting: boolean }> = drawn
        .filter((session) => session.state !== 'idle')
        .map((session) => ({ projectKey: session.projectKey, waiting: session.state === 'waiting' }));
      // `peek()` lists only running or waiting entries, so none of them is idle.
      for (const entry of await terminal.peek()) {
        if (isDuplicate(entry.openSessionId, false, drawnById)) continue;
        running.push({ projectKey: entry.projectKey, waiting: entry.state === 'waiting' });
      }
      return {
        generatedAt: now(),
        runningSessions: running.length,
        waitingSessions: running.filter((session) => session.waiting).length,
        runningProjects: new Set(running.map((session) => session.projectKey)).size,
      };
    },
  };
}

export type AgentMonitorService = ReturnType<typeof createAgentMonitorService>;
