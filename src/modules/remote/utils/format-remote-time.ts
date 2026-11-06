/**
 * Turns a timestamp from the management API into epoch milliseconds, or null
 * when there is none or it is unreadable. The contract does not say whether a
 * time is an ISO string or a number, so both are taken (a number below 1e11 can
 * only be seconds).
 */
export const parseRemoteTimestamp = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** A short local date and time for a management API timestamp; an empty string when it has none. */
export const formatRemoteTime = (value: unknown): string => {
  const ms = parseRemoteTimestamp(value);
  return ms === null ? '' : new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
};

/** The countdown form `m:ss` for a number of milliseconds (never negative). */
export const formatCountdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
