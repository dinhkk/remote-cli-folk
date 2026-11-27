import type { AgentMonitorProcessGroup, AgentMonitorUsage } from '@/shared/types.js';

/** One operating-system process as one sample saw it. `cpuSeconds` is the CPU time it has used since it started. */
export type RawProcess = {
  pid: number;
  ppid: number;
  name: string;
  cpuSeconds: number;
  /** Working set (resident memory) in bytes. */
  rssBytes: number;
  /** When the process started (epoch ms); null or absent when the reader does not know. Used to tell a reused pid from the original. */
  startedAt?: number | null;
};

/** Every process at one instant. */
export type ProcessSample = {
  at: number;
  byPid: Map<number, RawProcess>;
};

/** How many heaviest processes a usage entry lists. */
const TOP_PROCESSES = 5;

export function toSample(at: number, processes: RawProcess[]): ProcessSample {
  return { at, byPid: new Map(processes.map((entry) => [entry.pid, entry])) };
}

const finiteNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** What one read of the process table returns: the processes and, when the reader knows it, the moment they were read (epoch ms). */
export type ProcessReading = { takenAt: number | null; processes: RawProcess[] };

/**
 * Reads the JSON the Windows reader prints: `{ t, list: [{pid, ppid, name, cpu, rss}] }`, where `t` is the clock at the
 * instant the processes were read. A bare list is accepted too (PowerShell prints a lone object as an object).
 */
export function parseWindowsProcessJson(text: string): ProcessReading {
  const trimmed = text.trim();
  if (!trimmed) return { takenAt: null, processes: [] };
  const parsed: unknown = JSON.parse(trimmed);
  const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'list' in parsed ? parsed as { t?: unknown; list?: unknown } : null;
  const listed = envelope ? envelope.list : parsed;
  const rows = Array.isArray(listed) ? listed : [listed];
  const processes: RawProcess[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const pid = finiteNumber(entry.pid);
    if (pid <= 0) continue;
    processes.push({
      pid,
      ppid: finiteNumber(entry.ppid),
      name: typeof entry.name === 'string' ? entry.name : '',
      cpuSeconds: finiteNumber(entry.cpu),
      rssBytes: finiteNumber(entry.rss),
      startedAt: typeof entry.st === 'number' && Number.isFinite(entry.st) && entry.st > 0 ? entry.st : null,
    });
  }
  const takenAt = envelope && typeof envelope.t === 'number' && Number.isFinite(envelope.t) ? envelope.t : null;
  return { takenAt, processes };
}

/** `ps` CPU time: `[[dd-]hh:]mm:ss` (Linux) or `[hh:]mm:ss.ss` (macOS) to seconds. */
export function parsePsCpuTime(value: string): number {
  const [daysPart, rest] = value.includes('-') ? value.split('-') : ['0', value];
  const parts = rest.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number(daysPart) * 86_400 + seconds;
}

/**
 * Reads `ps -eo pid=,ppid=,rss=,time=,etime=,comm=` (rss in KiB; the command name may hold spaces and comes last). The
 * `etime` column (elapsed since start, `[[dd-]hh:]mm:ss`, on Linux and macOS alike) turns into `startedAt` when `takenAt`
 * (epoch ms of the read) is given. A line without it (`pid ppid rss time comm`) still reads, with `startedAt` null.
 */
export function parsePosixPs(text: string, takenAt: number | null = null): RawProcess[] {
  const processes: RawProcess[] = [];
  for (const line of text.split('\n')) {
    const withStart = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d[\d:-]*)\s+(.*)$/.exec(line);
    const match = withStart ?? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)()\s+(.*)$/.exec(line);
    if (!match) continue;
    const name = match[6].trim().split('/').pop() ?? '';
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuSeconds: parsePsCpuTime(match[4]),
      name,
      startedAt: withStart && takenAt !== null ? takenAt - parsePsCpuTime(match[5]) * 1000 : null,
    });
  }
  return processes;
}

/** Longest process name used as a group key (and sent out). */
const MAX_PROCESS_NAME_LENGTH = 48;

/** The key processes group under: the name trimmed, cut to 48, lower-cased; `unknown` when empty. Windows names are case-insensitive. */
export function groupKeyOf(name: string): string {
  return (name.trim().slice(0, MAX_PROCESS_NAME_LENGTH) || 'unknown').toLowerCase();
}

/** The root and every descendant of it in one sample. A parent id that is not a live process in the sample ends the walk. */
export function treePids(sample: ProcessSample, rootPid: number, includeDescendants = true): number[] {
  if (!sample.byPid.has(rootPid)) return [];
  if (!includeDescendants) return [rootPid];

  const children = new Map<number, number[]>();
  for (const entry of sample.byPid.values()) {
    if (entry.pid === entry.ppid) continue;
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }

  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/**
 * CPU time one process used between two samples, in seconds. A process that was not in the earlier sample started in
 * between, so all its CPU time counts — unless that is more than the interval could allow (then it only looks new,
 * for example a reused pid) and it counts as zero.
 */
function cpuDelta(previous: RawProcess | undefined, current: RawProcess, intervalSeconds: number, cores: number): number {
  if (previous) return current.cpuSeconds >= previous.cpuSeconds ? current.cpuSeconds - previous.cpuSeconds : 0;
  return current.cpuSeconds <= intervalSeconds * cores ? current.cpuSeconds : 0;
}

/** The processes `pids` of `current` with the CPU share each used since `previous` (null for all when nothing can be measured yet). */
function measureMembers(previous: ProcessSample | null, current: ProcessSample, pids: number[], cores: number) {
  const intervalSeconds = previous ? (current.at - previous.at) / 1000 : 0;
  const canMeasure = Boolean(previous) && intervalSeconds > 0 && cores > 0;
  const members = pids.map((pid) => {
    const entry = current.byPid.get(pid) as RawProcess;
    const delta = canMeasure ? cpuDelta(previous?.byPid.get(pid), entry, intervalSeconds, cores) : null;
    return { entry, cpuPercent: delta === null ? null : (delta / intervalSeconds / cores) * 100 };
  });
  return { members, canMeasure };
}

/** Process groups listed at most per session; the rest are summed into one unnamed "other" group. */
export const MAX_PROCESS_GROUPS = 8;

/**
 * The descendants of `rootPid` (the root itself excluded), grouped by process name: how many, their summed working set and
 * CPU share. Heaviest memory first, at most `MAX_PROCESS_GROUPS` groups; the groups past the cap are summed into one last
 * group whose name is empty (the client words it). Empty when the root is gone or has no children.
 *
 * Privacy: only the executable name, count, memory and CPU leave this function, never a command line, argument, path or
 * environment (the snapshot is readable by Remote controllers). `RawProcess` carries none of those, and this keeps it so.
 */
export function describeChildGroups(
  previous: ProcessSample | null,
  current: ProcessSample,
  rootPid: number,
  cores: number,
): AgentMonitorProcessGroup[] {
  const childPids = treePids(current, rootPid).filter((pid) => pid !== rootPid);
  if (childPids.length === 0) return [];

  const { members, canMeasure } = measureMembers(previous, current, childPids, cores);
  const round = (value: number) => Math.round(value * 100) / 100;

  // Windows names are case-insensitive: `Node` and `node` are one group, shown under the name seen first.
  const groups = new Map<string, AgentMonitorProcessGroup>();
  for (const { entry, cpuPercent } of members) {
    const name = entry.name.trim().slice(0, MAX_PROCESS_NAME_LENGTH) || 'unknown';
    const key = groupKeyOf(entry.name);
    const group = groups.get(key) ?? { name, count: 0, rssBytes: 0, cpuPercent: canMeasure ? 0 : null };
    group.count += 1;
    group.rssBytes += entry.rssBytes;
    if (group.cpuPercent !== null) group.cpuPercent += cpuPercent ?? 0;
    groups.set(key, group);
  }

  const sorted = [...groups.values()]
    .map((group) => ({ ...group, cpuPercent: group.cpuPercent === null ? null : round(group.cpuPercent) }))
    .sort((a, b) => b.rssBytes - a.rssBytes || b.count - a.count || a.name.localeCompare(b.name));
  if (sorted.length <= MAX_PROCESS_GROUPS) return sorted;

  const shown = sorted.slice(0, MAX_PROCESS_GROUPS - 1);
  const rest = sorted.slice(MAX_PROCESS_GROUPS - 1);
  const other: AgentMonitorProcessGroup = {
    name: '',
    count: rest.reduce((sum, group) => sum + group.count, 0),
    rssBytes: rest.reduce((sum, group) => sum + group.rssBytes, 0),
    cpuPercent: canMeasure ? round(rest.reduce((sum, group) => sum + (group.cpuPercent ?? 0), 0)) : null,
  };
  return [...shown, other];
}

/**
 * CPU and memory of the process tree under `rootPid`, or null when the root is gone.
 *
 * CPU% = CPU seconds used by the tree between the two samples / elapsed seconds / logical cores x 100, the scale Task
 * Manager uses (all cores busy = 100). It is null until there is an earlier sample to compare with. Memory is the sum
 * of the working sets, so shared pages are counted once per process, as in Task Manager's details view.
 */
export function measureTree(
  previous: ProcessSample | null,
  current: ProcessSample,
  rootPid: number,
  cores: number,
  includeDescendants = true,
): AgentMonitorUsage | null {
  const pids = treePids(current, rootPid, includeDescendants);
  if (pids.length === 0) return null;

  const { members, canMeasure } = measureMembers(previous, current, pids, cores);
  const cpuPercent = canMeasure ? members.reduce((sum, member) => sum + (member.cpuPercent ?? 0), 0) : null;
  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    cpuPercent: cpuPercent === null ? null : round(cpuPercent),
    rssBytes: members.reduce((sum, member) => sum + member.entry.rssBytes, 0),
    processCount: members.length,
    top: [...members]
      .sort((a, b) => b.entry.rssBytes - a.entry.rssBytes)
      .slice(0, TOP_PROCESSES)
      .map((member) => ({
        pid: member.entry.pid,
        name: member.entry.name,
        rssBytes: member.entry.rssBytes,
        cpuPercent: member.cpuPercent === null ? null : round(member.cpuPercent),
      })),
  };
}
