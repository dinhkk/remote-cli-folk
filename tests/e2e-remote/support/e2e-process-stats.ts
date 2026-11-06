// Small measurement helpers of the load tests: resident memory of a child process and percentiles.
import { execFileSync } from 'node:child_process';

/** Resident set size of a process in MiB (tasklist on Windows, ps elsewhere). */
export function rssMiB(pid: number): number {
  if (process.platform === 'win32') {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    // "node.exe","1234","Console","1","123,456 K": the memory column is the last quoted field.
    const fields = [...output.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    const kilobytes = Number((fields[fields.length - 1] ?? '').replace(/\D/g, ''));
    if (!Number.isFinite(kilobytes) || kilobytes === 0) throw new Error(`cannot read the memory of pid ${pid}: ${output.trim()}`);
    return kilobytes / 1024;
  }
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export const describeSamples = (values: number[]): string =>
  `n=${values.length} p50=${percentile(values, 50).toFixed(1)}ms p95=${percentile(values, 95).toFixed(1)}ms max=${Math.max(...values).toFixed(1)}ms`;
