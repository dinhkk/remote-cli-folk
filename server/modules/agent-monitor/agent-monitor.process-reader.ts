import { execFile } from 'node:child_process';

import { parsePosixPs, parseWindowsProcessJson, type ProcessReading } from './agent-monitor.process-usage.js';

/** Reads every process once. Rejects on failure or when `signal` aborts (the child is killed). */
export type ProcessReader = (signal: AbortSignal) => Promise<ProcessReading>;

/**
 * One PowerShell run: the parent ids from `Win32_Process` (it is the only place Windows keeps them; ~0.14-0.4 s) and the
 * CPU time and working set from `Process.GetProcesses()` (~0.05 s). The clock is read right before the latter, so CPU%
 * divides by the time between two reads of the process table, not by when PowerShell's slow start-up finished.
 * `Win32_PerfFormattedData_PerfProc_Process` and the raw perf class were measured at 43 s on the reference machine and
 * are never used.
 */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$parents = @{}',
  '$started = @{}',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId; if ($_.CreationDate) { $started[[int]$_.ProcessId] = [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } }',
  '$taken = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
  '$list = foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { try { [pscustomobject]@{ pid = $p.Id; ppid = [int]$parents[$p.Id]; name = $p.ProcessName; cpu = [math]::Round($p.TotalProcessorTime.TotalSeconds, 3); rss = $p.WorkingSet64; st = [int64]$started[$p.Id] } } catch {} }',
  'ConvertTo-Json -InputObject ([pscustomobject]@{ t = $taken; list = @($list) }) -Compress',
].join('; ');

function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** The platform's process reader: PowerShell on Windows, `ps` elsewhere (Linux and macOS). */
export function createProcessReader(platform: NodeJS.Platform = process.platform): ProcessReader {
  if (platform === 'win32') {
    return async (signal) =>
      parseWindowsProcessJson(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT], signal));
  }
  // `time=` is the CPU time (1 s resolution on Linux, so a short window reads coarse CPU%); `etime=` is the time since the
  // process started (it gives `startedAt`, which tells a reused pid from the original); `comm=` goes last because it may hold spaces.
  return async (signal) => {
    const text = await run('ps', ['-eo', 'pid=,ppid=,rss=,time=,etime=,comm='], signal);
    const takenAt = Date.now();
    return { takenAt, processes: parsePosixPs(text, takenAt) };
  };
}
