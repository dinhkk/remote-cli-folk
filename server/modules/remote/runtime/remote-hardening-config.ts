/**
 * Environment overrides of the hardening limits (phase 13). Every value has a safe default; a missing,
 * non-numeric or out-of-range value falls back to it (a typo must never switch a limit off by accident).
 *
 * - `REMOTECLI_REMOTE_QUOTA_STREAMS` (64), `REMOTECLI_REMOTE_QUOTA_PTY` (8), `REMOTECLI_REMOTE_QUOTA_WS` (8),
 *   `REMOTECLI_REMOTE_QUOTA_NEW_STREAMS_PER_SECOND` (50), `REMOTECLI_REMOTE_QUOTA_VIOLATIONS_PER_MINUTE` (20):
 *   per-pairing quota (FR-39) (with fallback to legacy `CLOUDCLI_REMOTE_*`).
 * - `REMOTECLI_REMOTE_QUOTA_SUSPEND_SECONDS` (300): how long a pairing that tripped the violation limit may
 *   not reconnect.
 * - `REMOTECLI_REMOTE_PAIRING_IDLE_DAYS` (30, 0 = never): idle expiry of pairings (FR-40); see `resolveIdleDays`.
 * - `REMOTECLI_REMOTE_AUDIT_RETENTION_DAYS` (30): how long audit rows are kept (FR-42).
 */

import type { RemoteQuotaLimits } from '@/shared/types.js';

import { DEFAULT_AUDIT_RETENTION_DAYS } from '../audit/audit.service.js';
import { DEFAULT_QUOTA_LIMITS } from '../quota/pairing-quota.service.js';

const DEFAULT_SUSPEND_SECONDS = 300;

/** A positive whole number, or `fallback` for anything else (unset, empty, text, zero, negative, fractional). */
const positiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

// Consumed by: the Remote runtime (one quota per Host link).
export const resolveQuotaLimitsFromEnv = (env: NodeJS.ProcessEnv): RemoteQuotaLimits => ({
  maxStreams: positiveInt(env.REMOTECLI_REMOTE_QUOTA_STREAMS ?? env.CLOUDCLI_REMOTE_QUOTA_STREAMS, DEFAULT_QUOTA_LIMITS.maxStreams),
  maxPty: positiveInt(env.REMOTECLI_REMOTE_QUOTA_PTY ?? env.CLOUDCLI_REMOTE_QUOTA_PTY, DEFAULT_QUOTA_LIMITS.maxPty),
  maxWs: positiveInt(env.REMOTECLI_REMOTE_QUOTA_WS ?? env.CLOUDCLI_REMOTE_QUOTA_WS, DEFAULT_QUOTA_LIMITS.maxWs),
  newStreamsPerSecond: positiveInt(env.REMOTECLI_REMOTE_QUOTA_NEW_STREAMS_PER_SECOND ?? env.CLOUDCLI_REMOTE_QUOTA_NEW_STREAMS_PER_SECOND, DEFAULT_QUOTA_LIMITS.newStreamsPerSecond),
  violationsPerMinute: positiveInt(env.REMOTECLI_REMOTE_QUOTA_VIOLATIONS_PER_MINUTE ?? env.CLOUDCLI_REMOTE_QUOTA_VIOLATIONS_PER_MINUTE, DEFAULT_QUOTA_LIMITS.violationsPerMinute),
});

/** Milliseconds an auto-disconnected pairing stays disconnected. */
export const resolveQuotaSuspendMs = (env: NodeJS.ProcessEnv): number =>
  positiveInt(env.REMOTECLI_REMOTE_QUOTA_SUSPEND_SECONDS ?? env.CLOUDCLI_REMOTE_QUOTA_SUSPEND_SECONDS, DEFAULT_SUSPEND_SECONDS) * 1000;

export const resolveAuditRetentionDays = (env: NodeJS.ProcessEnv): number =>
  positiveInt(env.REMOTECLI_REMOTE_AUDIT_RETENTION_DAYS ?? env.CLOUDCLI_REMOTE_AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS);
