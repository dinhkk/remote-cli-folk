/** Display helpers of the agent monitor: plain numbers in, short strings out. Used by the KPI strip, the graph and the usage panel. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** `1536` -> `1.5 KB`, `5` -> `5 B`. Binary units (1 KB = 1024 B), like Task Manager. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

/** `950` -> `950`, `12_300` -> `12.3k`, `2_400_000` -> `2.4M`. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A running time: `45` s -> `0:45`, `125` s -> `2:05`, `3725` s -> `1:02:05`. */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** `12.345` -> `12.3%`, `0.04` -> `<0.1%`, null (not measured yet) -> `—`. */
export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}
