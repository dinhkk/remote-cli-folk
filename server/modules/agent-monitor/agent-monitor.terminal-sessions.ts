import type { AgentMonitorSession } from '@/shared/types.js';

import { folderNameOf, projectKeyOf } from './agent-monitor.projects.js';
import type { TranscriptReader } from './agent-monitor.transcript-reader.js';
import { IDLE_SESSION_VISIBLE_MS, selectVisibleAgents } from './agent-monitor.visibility.js';

/** One live Claude CLI process of the CLI's own registry (`~/.claude/sessions/<pid>.json`): the fields this module reads. */
export type RegistryEntry = {
  /** The CLI's process id (the registry file's name); lets the monitor find the session's child processes. */
  pid?: number;
  providerSessionId: string;
  status: string;
  startedAt: number;
  cwd: string | null;
  entrypoint: string | null;
  name: string | null;
  statusUpdatedAt: number | null;
};

type AppSessionLookup = { sessionId: string; label: string | null };

type TerminalSessionsOptions = {
  listLive: () => Promise<RegistryEntry[]>;
  /** The app chat that shows a Claude session id, when the app indexed it. */
  findAppSession: (providerSessionId: string) => AppSessionLookup | null;
  /** The app's name for a folder (a custom project name, else the folder name). */
  resolveProjectName: (cwd: string | null) => string | null;
  transcripts: Pick<TranscriptReader, 'readSession'>;
  now?: () => number;
  /** Time between the end of one refresh and the start of the next while somebody watches. */
  intervalMs?: number;
  /** How long one `touch()` keeps refreshing. The open screen touches it on every poll. */
  leaseMs?: number;
  /** The registry is re-read at most this often, however many viewers and summaries ask. */
  registryTtlMs?: number;
  /** Terminal sessions listed at most (the busiest and newest). */
  maxSessions?: number;
};

/** A session of the registry that is running or waiting, as the cheap summary sees it (no transcript read). */
export type TerminalActivityEntry = { openSessionId: string | null; projectKey: string; state: 'running' | 'waiting' };

type RegistryState = 'running' | 'waiting' | 'idle';

/**
 * The CLI's own status word. `busy` is the one seen on a real registry; `waiting` is assumed for a turn blocked on the
 * user. Any other word reads as idle: the monitor never claims work it cannot see.
 */
function registryStateOf(status: string): RegistryState {
  if (status === 'busy') return 'running';
  if (status === 'waiting') return 'waiting';
  return 'idle';
}

/**
 * Sessions the app did not drive: Claude CLI processes started in a terminal (or an editor), found through the CLI's own
 * registry and read from the transcript files it writes. The app has no event stream for them, so what the screen shows is
 * derived, not live: state from the registry's status word, agents from each sub-agent's `.meta.json` plus the tail of its
 * transcript. Anything not derivable stays unknown (see the transcript reader).
 *
 * Two entry points, with different costs. `peek()` reads only the small registry files (cached for `registryTtlMs`) and is
 * what the header badge uses while no screen is open. The transcript reading runs only after `touch()` (the open screen's
 * poll) and stops by itself when the lease lapses, the way the CPU/RAM sampler does.
 */
export function createTerminalSessionReader({
  listLive,
  findAppSession,
  resolveProjectName,
  transcripts,
  now = Date.now,
  intervalMs = 2000,
  leaseMs = 8000,
  registryTtlMs = 1500,
  maxSessions = 20,
}: TerminalSessionsOptions) {
  let registryCache: { at: number; entries: RegistryEntry[] } | null = null;
  let registryRead: Promise<RegistryEntry[]> | null = null;

  let leaseUntil = 0;
  let looping = false;
  let disposed = false;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let sessions: AgentMonitorSession[] = [];
  // Claude process id of each listed session, as of the last refresh (same lifetime as `sessions`).
  let pids = new Map<string, number>();

  /** The registry, shared between viewers: one read serves every caller within the TTL. A failed read counts as empty. */
  function readRegistry(): Promise<RegistryEntry[]> {
    if (registryCache && now() - registryCache.at < registryTtlMs) return Promise.resolve(registryCache.entries);
    registryRead ??= listLive()
      .catch(() => [] as RegistryEntry[])
      .then((entries) => {
        registryCache = { at: now(), entries };
        return entries;
      })
      .finally(() => { registryRead = null; });
    return registryRead;
  }

  /**
   * The registry entries worth showing, each with the app chat it maps to. An entry the app itself started (entrypoint
   * `remotecli`) that the app has not indexed yet is a run that is just starting: the event stream already covers it.
   */
  async function readEntries(): Promise<Array<{ entry: RegistryEntry; app: AppSessionLookup | null; state: RegistryState }>> {
    const entries = await readRegistry();
    const result: Array<{ entry: RegistryEntry; app: AppSessionLookup | null; state: RegistryState }> = [];
    for (const entry of entries) {
      let app: AppSessionLookup | null = null;
      try {
        app = findAppSession(entry.providerSessionId);
      } catch {
        // A store that cannot be read only costs the tap-through.
      }
      if (entry.entrypoint === 'remotecli' && !app) continue;
      result.push({ entry, app, state: registryStateOf(entry.status) });
    }
    return result;
  }

  const sinceStatus = (entry: RegistryEntry): number => entry.statusUpdatedAt ?? entry.startedAt;

  async function buildSession(item: Awaited<ReturnType<typeof readEntries>>[number], at: number): Promise<AgentMonitorSession> {
    const { entry, app, state } = item;
    const detail = await transcripts.readSession(entry.cwd, entry.providerSessionId);
    const { live, shown, folded } = selectVisibleAgents(detail.agents, at);

    const working = state === 'running' || live.length > 0;
    const sessionState: AgentMonitorSession['state'] = state === 'waiting' ? 'waiting' : working ? 'running' : 'idle';
    const folder = folderNameOf(entry.cwd);
    const agentActivity = detail.agents.reduce((latest, agent) => Math.max(latest, agent.endedAt ?? agent.startedAt), 0);

    return {
      id: `terminal:${entry.providerSessionId}`,
      label: app?.label || entry.name || folder || entry.providerSessionId.slice(0, 8),
      projectName: resolveProjectName(entry.cwd) ?? folder,
      provider: 'claude',
      state: sessionState,
      runStartedAt: sessionState === 'idle' ? null : sinceStatus(entry),
      lastEventAt: Math.max(sinceStatus(entry), detail.lastWriteAt ?? 0, agentActivity),
      orchestrator: {
        name: 'Main agent',
        fromProfile: false,
        state: state === 'waiting' ? 'waiting' : working ? 'running' : 'done',
        lastToolName: state === 'running' ? detail.lastToolName : null,
        contextTokens: detail.contextTokens,
        contextWindow: null,
      },
      agents: shown,
      foldedFinished: folded,
      agentTokens: detail.agents.reduce((sum, agent) => sum + agent.tokens, 0),
      cacheHitRatio: null,
      source: entry.entrypoint === 'remotecli' ? 'app' : 'terminal',
      detail: 'transcript',
      projectPath: entry.cwd,
      projectKey: projectKeyOf(entry.cwd),
      openSessionId: app?.sessionId ?? null,
    };
  }

  /** One refresh: read the registry, then the transcripts of the sessions worth showing. Never throws. */
  async function refresh(): Promise<void> {
    try {
      const at = now();
      const items = (await readEntries())
        // An idle session stays listed for a short while after its last turn (like an app chat), then drops out.
        .filter((item) => item.state !== 'idle' || at - sinceStatus(item.entry) <= IDLE_SESSION_VISIBLE_MS)
        .sort((a, b) => Number(b.state !== 'idle') - Number(a.state !== 'idle') || sinceStatus(b.entry) - sinceStatus(a.entry))
        .slice(0, maxSessions);
      const built = await Promise.all(items.map((item) => buildSession(item, at)));
      sessions = built;
      pids = new Map(items.flatMap((item, index) => (item.entry.pid ? [[built[index].id, item.entry.pid] as const] : [])));
    } catch {
      // A failed refresh keeps the last result; the next one retries.
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
      await refresh();
      if (disposed || now() >= leaseUntil) break;
      await sleep(intervalMs);
    }
    looping = false;
    // Nobody is watching: drop the result so the next viewer never sees an old picture.
    sessions = [];
    pids = new Map();
  }

  return {
    /** Called by every poll of the open screen: keeps the transcript reading going for another lease. */
    touch(): void {
      if (disposed) return;
      leaseUntil = now() + leaseMs;
      if (!looping) {
        looping = true;
        void loop();
      }
    },

    /** The terminal sessions as of the last refresh (empty until the first one finishes, and after the lease lapsed). */
    current(): AgentMonitorSession[] {
      return sessions;
    },

    /** The Claude process id of a session returned by `current()`; null when the registry did not give one. */
    pidOf(sessionId: string): number | null {
      return pids.get(sessionId) ?? null;
    },

    /** Running and waiting sessions from the registry alone, for the header badge: no transcript is read. */
    async peek(): Promise<TerminalActivityEntry[]> {
      const items = await readEntries();
      return items
        .filter((item): item is typeof item & { state: 'running' | 'waiting' } => item.state !== 'idle')
        .map((item) => ({ openSessionId: item.app?.sessionId ?? null, projectKey: projectKeyOf(item.entry.cwd), state: item.state }));
    },

    /** Runs one refresh now, outside the loop (tests drive the reader with this). */
    refresh,

    /** Ends the loop at once and refuses further touches (server shutdown, tests). */
    dispose(): void {
      disposed = true;
      leaseUntil = 0;
      if (sleepTimer) clearTimeout(sleepTimer);
      wake?.();
    },
  };
}

export type TerminalSessionReader = ReturnType<typeof createTerminalSessionReader>;
