import { execFile } from 'node:child_process';
import path from 'node:path';

import { groupKeyOf, treePids, toSample, type ProcessReading, type ProcessSample, type RawProcess } from './process-usage.js';

/**
 * Process-kill core: picks the exact processes to kill from a FRESH read of the process table, checks they are safe to kill,
 * kills them and says what happened by reading the table again. It knows nothing of HTTP, sessions or the aggregator.
 *
 * The outcome is never taken from the kill command's exit code: `taskkill` answers 128 both for "already gone" and for
 * "denied" (measured), so only a second read of the table tells. No pid leaves this module: callers get a result and a count.
 */

/** Image names a Claude CLI root may have. Windows: `claude.exe` (measured). POSIX is not measured, so `node` and `bun` are allowed there too. */
const CLAUDE_ROOT_NAMES: Record<'win32' | 'posix', readonly string[]> = { win32: ['claude'], posix: ['claude', 'node', 'bun'] };
/** A root's start time (from the process table) may differ from the CLI registry's `startedAt` by this much. Measured: the process starts 0.5-1.9 s BEFORE the registry is written. */
export const START_TIME_EPSILON_MS = 10_000;
/** Most pids sent to the kill command in one request. */
export const MAX_KILL_PIDS = 64;
/** The read of the process table, and a kill command, each give up after this long. */
const READ_TIMEOUT_MS = 8_000;
const KILL_TIMEOUT_MS = 5_000;
/** A child cannot start before its parent: when it appears to, by more than this, the parent pid was reused. */
const ORPHAN_SLACK_MS = 1_000;

export type KillResult = 'killed' | 'gone' | 'refused' | 'error' | 'unavailable';
export type KillOutcome = { result: KillResult; count: number };

/** Runs one kill command. Its rejection (a non-zero exit) is ignored on purpose; see the header. */
export type KillRun = (command: string, args: string[], signal: AbortSignal) => Promise<void>;
export type KillInvocation = { command: string; args: string[] };

const isPid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** The commands that kill `pids` (in the order given). Windows: `taskkill` by absolute path; POSIX: `kill -KILL`, no shell. */
export function killInvocations(
  platform: NodeJS.Platform,
  pids: readonly number[],
  { tree }: { tree: boolean },
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): KillInvocation[] {
  for (const pid of pids) {
    if (!isPid(pid)) throw new Error('pid must be a positive integer');
  }
  if (platform === 'win32') {
    const command = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    return pids.map((pid) => ({ command, args: tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'] }));
  }
  return pids.map((pid) => ({ command: 'kill', args: ['-KILL', String(pid)] }));
}

/** The pid and every ancestor of it in the sample (a parent id that is not a process, or a cycle, ends the walk). */
function ancestorsOf(sample: ProcessSample, pid: number): Set<number> {
  const seen = new Set<number>();
  let cursor: number | undefined = pid;
  while (cursor !== undefined && sample.byPid.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    cursor = sample.byPid.get(cursor)?.ppid;
  }
  return seen;
}

/**
 * The pids a kill must not touch: the server, everything above it, the rest of its tree, and the whole tree of every other
 * Claude root. The tree of `rootPid` (the one being killed) is taken out of that, because an app chat's Claude is itself a
 * child of the server.
 */
export function protectedSet(sample: ProcessSample, serverPid: number, otherRoots: readonly number[], rootPid: number): Set<number> {
  const target = new Set(treePids(sample, rootPid));
  const guard = new Set<number>(ancestorsOf(sample, serverPid));
  for (const pid of treePids(sample, serverPid)) if (!target.has(pid)) guard.add(pid);
  for (const other of otherRoots) {
    if (other === rootPid) continue;
    for (const pid of treePids(sample, other)) guard.add(pid);
  }
  return guard;
}

/**
 * The descendants of `rootPid` whose name belongs to group `groupKey`, without the root and without the protected pids.
 * A descendant that seems to have started before its parent is left out: its parent pid was reused, it is not a child.
 * An empty or `unknown` group selects nothing (the client never sends one; the server will not guess).
 */
export function selectGroupPids(sample: ProcessSample, rootPid: number, groupKey: string, guard: ReadonlySet<number>): number[] {
  if (!groupKey || groupKey === 'unknown') return [];
  return treePids(sample, rootPid).filter((pid) => {
    if (pid === rootPid || guard.has(pid)) return false;
    const entry = sample.byPid.get(pid) as RawProcess;
    if (groupKeyOf(entry.name) !== groupKey) return false;
    const parent = sample.byPid.get(entry.ppid);
    return !(entry.startedAt && parent?.startedAt && entry.startedAt + ORPHAN_SLACK_MS < parent.startedAt);
  });
}

/** `ok` only for a Claude image that started when the CLI registry says it did; anything unknown is refused. */
export function verifyClaudeRoot(entry: RawProcess | undefined, registryStartedAt: number | null, platform: NodeJS.Platform): 'ok' | 'refused' {
  if (!entry || registryStartedAt === null || !entry.startedAt) return 'refused';
  const names = CLAUDE_ROOT_NAMES[platform === 'win32' ? 'win32' : 'posix'];
  if (!names.includes(entry.name.trim().toLowerCase().replace(/\.exe$/, ''))) return 'refused';
  return Math.abs(entry.startedAt - registryStartedAt) <= START_TIME_EPSILON_MS ? 'ok' : 'refused';
}

export type KillContext = {
  /** `startedAt` of the root's entry in the CLI registry (epoch ms); null when unknown (then nothing is killed). */
  registryStartedAt: number | null;
  /** The pids of every OTHER Claude root the registry lists. */
  otherRoots: readonly number[];
};

type ProcessKillerOptions = {
  readProcesses: (signal: AbortSignal) => Promise<ProcessReading>;
  run: KillRun;
  serverPid: number;
  platform?: NodeJS.Platform;
  /** `SystemRoot`, for the absolute path of `taskkill`. */
  systemRoot?: string;
};

/** The default `run`: `execFile` (no shell) with a timeout. */
export const runKillCommand: KillRun = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { signal, windowsHide: true, timeout: KILL_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
  });

export function createProcessKiller({ readProcesses, run, serverPid, platform = process.platform, systemRoot }: ProcessKillerOptions) {
  const read = async (): Promise<ProcessSample | null> => {
    try {
      const reading = await readProcesses(AbortSignal.timeout(READ_TIMEOUT_MS));
      return toSample(reading.takenAt ?? Date.now(), reading.processes);
    } catch {
      return null;
    }
  };

  /** Runs every command; a failure of one never stops the others or leaves this function. */
  const execute = async (invocations: KillInvocation[]): Promise<void> => {
    await Promise.all(invocations.map(async ({ command, args }) => {
      try {
        await run(command, args, AbortSignal.timeout(KILL_TIMEOUT_MS));
      } catch {
        // Judged by the table afterwards; see the header.
      }
    }));
  };

  /** The root must be a claude started when the registry says, and neither the server nor above it. */
  const refuseRoot = (sample: ProcessSample, rootPid: number, context: KillContext): boolean =>
    verifyClaudeRoot(sample.byPid.get(rootPid), context.registryStartedAt, platform) !== 'ok'
    || rootPid === serverPid
    || ancestorsOf(sample, serverPid).has(rootPid);

  return {
    /** Kills the processes of one name group under a Claude root. */
    async killGroup(rootPid: number, groupKey: string, context: KillContext): Promise<KillOutcome> {
      if (!groupKey || groupKey === 'unknown') return { result: 'refused', count: 0 };
      const before = await read();
      if (!before) return { result: 'unavailable', count: 0 };
      if (!before.byPid.has(rootPid)) return { result: 'gone', count: 0 };
      if (refuseRoot(before, rootPid, context)) return { result: 'refused', count: 0 };

      const guard = protectedSet(before, serverPid, context.otherRoots, rootPid);
      const selected = selectGroupPids(before, rootPid, groupKey, guard);
      if (selected.length === 0) return { result: 'gone', count: 0 };
      const batch = selected.slice(0, MAX_KILL_PIDS);

      // A child with the same name under a process being killed dies with it (`/T`), unless that would reach a protected pid.
      const wide = batch.filter((pid) => !treePids(before, pid).some((member) => guard.has(member)));
      const narrow = batch.filter((pid) => !wide.includes(pid));
      await execute([
        ...killInvocations(platform, wide, { tree: true }, systemRoot),
        ...killInvocations(platform, narrow, { tree: false }, systemRoot),
      ]);

      const after = await read();
      if (!after) return { result: 'error', count: 0 };
      const survivors = selected.filter((pid) => after.byPid.has(pid) && after.byPid.get(pid)?.startedAt === before.byPid.get(pid)?.startedAt);
      return survivors.length === 0 ? { result: 'killed', count: selected.length } : { result: 'error', count: selected.length - survivors.length };
    },

    /** Kills a Claude root and everything under it. */
    async killTree(rootPid: number, context: KillContext): Promise<KillOutcome> {
      const before = await read();
      if (!before) return { result: 'unavailable', count: 0 };
      if (!before.byPid.has(rootPid)) return { result: 'gone', count: 0 };
      if (refuseRoot(before, rootPid, context)) return { result: 'refused', count: 0 };

      const members = treePids(before, rootPid);
      // A tree that holds another chat's Claude would take it down too.
      if (context.otherRoots.some((other) => other !== rootPid && members.includes(other))) return { result: 'refused', count: 0 };
      // Windows' `/T` walks the tree itself. POSIX has no tree kill: the root goes first and alone (so nothing respawns
      // its children), then every other member, in batches, so a tree of any size is taken down completely.
      if (platform === 'win32') {
        await execute(killInvocations(platform, [rootPid], { tree: true }, systemRoot));
      } else {
        await execute(killInvocations(platform, [rootPid], { tree: false }, systemRoot));
        const rest = members.filter((pid) => pid !== rootPid);
        for (let index = 0; index < rest.length; index += MAX_KILL_PIDS) {
          await execute(killInvocations(platform, rest.slice(index, index + MAX_KILL_PIDS), { tree: false }, systemRoot));
        }
      }

      const after = await read();
      if (!after) return { result: 'error', count: 0 };
      // A pid counts as alive only with the start time it had before: a reused pid is a different process.
      const survivors = members.filter((pid) => after.byPid.has(pid) && after.byPid.get(pid)?.startedAt === before.byPid.get(pid)?.startedAt);
      return survivors.length === 0 ? { result: 'killed', count: members.length } : { result: 'error', count: members.length - survivors.length };
    },
  };
}

export type ProcessKiller = ReturnType<typeof createProcessKiller>;
