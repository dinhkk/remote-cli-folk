import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { listLiveClaudeCliProcesses, providerRuntimeService, providerTokenUsageService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { createProcessKiller, runKillCommand, createProcessReader } from '@/modules/process-control/index.js';

import { createAgentActivityAggregator, type MonitorSessionMeta } from './agent-monitor.aggregator.js';
import { createAgentMonitorKiller, type KillSessionInfo } from './agent-monitor.kill.js';
import { folderNameOf } from './agent-monitor.projects.js';
import { createAgentMonitorRouter } from './agent-monitor.routes.js';
import { createResourceSampler, type SamplerTarget } from './agent-monitor.sampler.js';
import { createAgentMonitorService } from './agent-monitor.service.js';
import { createTerminalSessionReader } from './agent-monitor.terminal-sessions.js';
import { createTranscriptReader } from './agent-monitor.transcript-reader.js';

const SAMPLE_INTERVAL_MS = 2000;
/** Other Claude processes listed at most (the ones started last); a developer machine can hold many idle CLIs. */
const MAX_EXTERNAL_PROCESSES = 10;

const folderName = folderNameOf;

/** The app's name for a folder: the project's custom name when it has one, else the folder name. */
function resolveProjectName(directory: string | null): string | null {
  if (!directory) return null;
  try {
    return projectsDb.getCustomProjectName(directory) || folderName(directory);
  } catch {
    return folderName(directory);
  }
}

/** What the app store knows about a session: its name, folder and the orchestrator of its agent snapshot. */
function readSessionMeta(sessionId: string): MonitorSessionMeta | null {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row) return null;
  let orchestratorName: string | null = null;
  try {
    orchestratorName = sessionsDb.getAgentSnapshot(sessionId)?.agentName ?? null;
  } catch {
    // An unreadable snapshot only loses the orchestrator's name; the monitor never refuses a session for it.
  }
  const projectName = resolveProjectName(row.project_path);
  // A brand-new session is stored as "Untitled Session": the folder says more.
  const named = row.custom_name && row.custom_name !== 'Untitled Session' ? row.custom_name : null;
  return {
    label: named || projectName || sessionId.slice(0, 8),
    projectName,
    projectPath: row.project_path,
    provider: row.provider,
    orchestratorName,
  };
}

/** What the app store knows about a Claude session id that the CLI registry lists: the chat that shows it, and its name. */
function findAppSession(providerSessionId: string): { sessionId: string; label: string | null } | null {
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  if (!row) return null;
  return { sessionId: row.session_id, label: readSessionMeta(row.session_id)?.label ?? null };
}

/**
 * The process trees to measure: this server (its own process only), every live Claude process of a session the app
 * runs (the tree under it holds its tool processes), and a few Claude processes the app did not start (CPU/RAM only).
 * Read from the CLI's own registry (`~/.claude/sessions/<pid>.json`) on each sample, so a session that starts or ends
 * while the screen is open appears or disappears by itself.
 */
async function listTargets(): Promise<SamplerTarget[]> {
  const targets: SamplerTarget[] = [{ key: 'server', kind: 'server', label: 'Server', pid: process.pid, includeDescendants: false }];
  const external: SamplerTarget[] = [];

  const live = (await listLiveClaudeCliProcesses()).sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
  const seenSessions = new Set<string>();
  for (const entry of live) {
    const appSession = sessionsDb.getSessionByProviderSessionId(entry.providerSessionId);
    if (appSession) {
      const key = seenSessions.has(appSession.session_id) ? `session:${appSession.session_id}:process:${entry.pid}` : `session:${appSession.session_id}`;
      seenSessions.add(appSession.session_id);
      targets.push({
        key,
        kind: 'session',
        label: readSessionMeta(appSession.session_id)?.label ?? appSession.session_id.slice(0, 8),
        pid: entry.pid,
        includeDescendants: true,
      });
    } else if (external.length < MAX_EXTERNAL_PROCESSES) {
      external.push({
        key: `external:${entry.pid}`,
        kind: 'external',
        label: `${folderName(entry.cwd) ?? 'Claude'}${entry.entrypoint ? ` (${entry.entrypoint})` : ''}`,
        pid: entry.pid,
        includeDescendants: true,
      });
    }
  }
  return [...targets, ...external];
}

/** Share of the latest request that was served from the prompt cache; null when the transcript says nothing. */
async function readCacheHitRatio(sessionId: string): Promise<number | null> {
  const usage = await providerTokenUsageService.getSessionTokenUsage(sessionId);
  const cacheRead = usage.cacheReadTokens ?? 0;
  const total = usage.inputTokens + cacheRead + (usage.cacheCreationTokens ?? 0);
  return total > 0 ? cacheRead / total : null;
}

const aggregator = createAgentActivityAggregator({ readSessionMeta });

// The aggregator only listens to the same live events the chat gateway sends to the browser.
chatRunRegistry.addObserver((event) => {
  if (event.type === 'run-started') aggregator.startRun(event.appSessionId, event.startedAt);
  else aggregator.ingest(event.appSessionId, event.message);
});

const cores = Math.max(1, os.cpus().length);
// Sampling starts only when a screen polls the snapshot and ends a few seconds after the last poll.
const sampler = createResourceSampler({ readProcesses: createProcessReader(), listTargets, cores, intervalMs: SAMPLE_INTERVAL_MS });

// Claude sessions the app did not start (terminal): the CLI's registry plus its transcript files, read only while a screen is open.
const terminal = createTerminalSessionReader({
  listLive: listLiveClaudeCliProcesses,
  findAppSession,
  resolveProjectName,
  transcripts: createTranscriptReader({ claudeHome: path.join(os.homedir(), '.claude') }),
});

/** The terminal session ids the monitor draws are `terminal:<Claude session id>`. */
const TERMINAL_PREFIX = 'terminal:';

/** What the kill route needs to know about a session id the client sent; null when the app has never heard of it. */
function describeSessionForKill(sessionId: string): KillSessionInfo | null {
  if (sessionId.startsWith(TERMINAL_PREFIX)) {
    const earlier = terminal.earlierRootOf(sessionId);
    if (earlier) return { provider: 'claude', providerSessionId: earlier.providerSessionId, terminal: true, root: earlier };
    if (sessionId.includes(':process:')) return null;
    return { provider: 'claude', providerSessionId: sessionId.slice(TERMINAL_PREFIX.length), terminal: true };
  }
  const row = sessionsDb.getSessionById(sessionId);
  return row ? { provider: row.provider, providerSessionId: row.provider_session_id, terminal: false } : null;
}

/** Stops an agent or kills processes of a session. Every pid is read when the kill is asked for, never kept (see `agent-monitor.kill.ts`). */
const killer = createAgentMonitorKiller({
  aggregator,
  describeSession: describeSessionForKill,
  listLive: listLiveClaudeCliProcesses,
  processKiller: createProcessKiller({ readProcesses: createProcessReader(), run: runKillCommand, serverPid: process.pid }),
  stopTask: (sessionId, taskId) => providerRuntimeService.stopBackgroundTask('claude', sessionId, taskId),
  markKilled: (sessionId) => providerRuntimeService.markSessionKilled('claude', sessionId),
  unmarkKilled: (sessionId) => providerRuntimeService.unmarkSessionKilled('claude', sessionId),
  completeRun: (sessionId) => {
    // The same terminal event `chat.abort` sends, so the browser sees the run end as aborted, not failed.
    const run = chatRunRegistry.getRun(sessionId);
    if (run) chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
  },
});

/** Agent monitor router, mounted by the server entrypoint at `/api/agent-monitor`. */
export const agentMonitorRoutes = createAgentMonitorRouter(
  createAgentMonitorService({ aggregator, terminal, sampler, cores, intervalMs: SAMPLE_INTERVAL_MS, readCacheHitRatio }),
  killer,
);

/** Stops the sampler and the terminal-session reader (server shutdown). */
export function stopAgentMonitor(): void {
  sampler.dispose();
  terminal.dispose();
}
