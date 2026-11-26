import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import { createProcessReader, killInvocations, protectedSet, runKillCommand, toSample, treePids } from '@/modules/process-control/index.js';
import type { ProcessReader, KillRun } from '@/modules/process-control/index.js';
import { listLiveClaudeCliProcesses } from '@/modules/providers/services/claude-cli-liveness.service.js';

/** The provider waits for this grace period before forcibly ending an owned process tree. */
const GRACE_MS = 2_000;
const READ_MS = 2_000;
const KILL_MS = 1_000;

type LifecycleOptions = {
  read?: ProcessReader;
  run?: KillRun;
  listRoots?: () => Promise<Array<{ pid: number }>>;
  graceMs?: number;
  serverPid?: number;
  platform?: NodeJS.Platform;
};

/** Used by the Claude runtime to retain and end the exact child it spawned before another turn can start. */
export function createClaudeProcessLifecycle({ read = createProcessReader(), run = runKillCommand,
  listRoots = listLiveClaudeCliProcesses, graceMs = GRACE_MS, serverPid = process.pid,
  platform = process.platform }: LifecycleOptions = {}) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let stopping: Promise<void> | null = null;
  // Retain identities across retries, including descendants orphaned by a partially successful stop.
  const owned = new Map<number, string>();
  let deadline = 0;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Previous Claude cleanup timed out');
    return ms;
  };
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Previous Claude cleanup timed out')), remaining());
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const identity = async (pid: number, startedAt: number | null | undefined): Promise<string | null> => {
    if (platform === 'linux') {
      try {
        const stat = await bounded(readFile(`/proc/${pid}/stat`, 'utf8'));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] === 'Z' ? null : fields[19] ?? null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null;
        throw error;
      }
    }
    if (platform !== 'win32') {
      // elapsed-time samples are rounded and drift; use the OS start timestamp on macOS.
      return bounded(new Promise<string | null>((resolve, reject) => {
        execFile('ps', ['-p', String(pid), '-o', 'lstart=,stat='], {
          encoding: 'utf8', signal: AbortSignal.timeout(Math.min(READ_MS, remaining())),
        }, (error, stdout) => {
          const value = stdout.trim();
          if (error && !value && error.code === 1) resolve(null);
          else if (error) reject(error);
          else resolve(!value || /\sZ\S*$/.test(value) ? null : value.split(/\s+/).slice(0, 5).join(' '));
        });
      }));
    }
    return startedAt ? String(startedAt) : null;
  };
  const sample = async () => {
    const reading = await read(AbortSignal.timeout(Math.min(READ_MS, remaining())));
    return toSample(reading.takenAt ?? Date.now(), reading.processes);
  };
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function stop(cooperate: () => void): Promise<void> {
    // Scripted SDK queries in tests have no operating-system process.
    if (!child?.pid) { cooperate(); return; }
    deadline = Date.now() + 12_000;
    const rootPid = child.pid;
    const before = await sample();
    const root = before.byPid.get(rootPid);
    // An exited ChildProcess cannot authorize a newly reused pid.
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (root && !exited) {
      if (root.ppid !== serverPid || !root.startedAt) throw new Error('Cannot verify the previous Claude process');
      const otherRoots = (await bounded(listRoots())).filter((entry) => entry.pid !== rootPid).map((entry) => entry.pid);
      const guard = protectedSet(before, serverPid, otherRoots, rootPid);
      const members = treePids(before, rootPid);
      if (members.some((pid) => guard.has(pid))) throw new Error('Previous Claude tree contains a protected session');
      for (const pid of members) {
        const startedAt = before.byPid.get(pid)?.startedAt;
        if (!startedAt) throw new Error('Cannot verify a previous Claude descendant');
        const id = await identity(pid, startedAt);
        if (id) owned.set(pid, id);
      }
    }
    cooperate();
    if (owned.size === 0) return;
    await delay(graceMs);
    let current = await sample();
    // Capture children created during the grace period, but only while the original root is still alive.
    if (await identity(rootPid, current.byPid.get(rootPid)?.startedAt) === owned.get(rootPid)) {
      const otherRoots = (await bounded(listRoots())).filter((entry) => entry.pid !== rootPid).map((entry) => entry.pid);
      const guard = protectedSet(current, serverPid, otherRoots, rootPid);
      for (const pid of treePids(current, rootPid)) {
        if (guard.has(pid)) throw new Error('Previous Claude tree contains a protected session');
        const startedAt = current.byPid.get(pid)?.startedAt;
        if (!startedAt) throw new Error('Cannot verify a previous Claude descendant');
        const id = await identity(pid, startedAt);
        if (id) owned.set(pid, id);
      }
    }
    const survivors = async () => {
      const live: number[] = [];
      for (const [pid, id] of owned) {
        if (current.byPid.has(pid) && await identity(pid, current.byPid.get(pid)?.startedAt) === id) live.push(pid);
      }
      return live;
    };
    // Use exact pids rather than an OS-wide name or process-group kill. PID reuse is checked before every command.
    for (const pid of (await survivors()).sort((a, b) => Number(b === rootPid) - Number(a === rootPid))) {
      current = await sample();
      if (await identity(pid, current.byPid.get(pid)?.startedAt) !== owned.get(pid)) continue;
      const otherRoots = (await bounded(listRoots())).filter((entry) => entry.pid !== rootPid).map((entry) => entry.pid);
      if (otherRoots.some((other) => treePids(current, other).includes(pid))) throw new Error('A previous process now belongs to another session');
      for (const invocation of killInvocations(platform, [pid], { tree: false })) {
        try { await run(invocation.command, invocation.args, AbortSignal.timeout(Math.min(KILL_MS, remaining()))); } catch { /* Verify below. */ }
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      current = await sample();
      if ((await survivors()).length === 0) { owned.clear(); return; }
      await delay(50);
    }
    throw new Error('Previous Claude work is still running; retry after stopping it in Running');
  }

  return {
    spawn(options: SpawnOptions, stderr?: (text: string) => void) {
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
        signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.on('data', (data: Buffer) => stderr?.(data.toString()));
      return child;
    },
    stop(cooperate: () => void): Promise<void> {
      stopping ??= stop(cooperate).finally(() => { stopping = null; });
      return stopping;
    },
  };
}
