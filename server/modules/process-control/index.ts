// Shared by provider lifecycle cleanup and the agent monitor's process sampling and kill controls.
export { createProcessReader } from './process-reader.js';
export type { ProcessReader } from './process-reader.js';
export { createProcessKiller, runKillCommand, killInvocations, protectedSet, selectGroupPids, verifyClaudeRoot, START_TIME_EPSILON_MS, MAX_KILL_PIDS } from './process-kill.js';
export type { KillContext, KillOutcome, KillResult, KillRun, KillInvocation, ProcessKiller } from './process-kill.js';
export { toSample, parseWindowsProcessJson, parsePsCpuTime, parsePosixPs, groupKeyOf, treePids, describeChildGroups, measureTree, MAX_PROCESS_GROUPS } from './process-usage.js';
export type { RawProcess, ProcessSample, ProcessReading } from './process-usage.js';
