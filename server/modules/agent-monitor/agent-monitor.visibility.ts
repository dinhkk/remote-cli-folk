import type { AgentMonitorState } from '@/shared/types.js';

/** A finished agent stays drawn this long (so the "done" motion is seen), then folds into a counter. */
export const FINISHED_VISIBLE_MS = 90_000;
/** At most this many finished agents are drawn per session, newest first. */
export const MAX_FINISHED_SHOWN = 6;
/** A session with nothing running leaves the picture this long after its last event. */
export const IDLE_SESSION_VISIBLE_MS = 2 * 60_000;

/** True for the two states of an agent that is still working (`waiting` = blocked on a permission answer). */
export const isLiveState = (state: AgentMonitorState): boolean => state === 'running' || state === 'waiting';

type TimedAgent = { state: AgentMonitorState; startedAt: number; endedAt: number | null };

/**
 * Which agents of a session are drawn: all the working ones (oldest first), then the finished ones that ended recently
 * (newest first, at most `MAX_FINISHED_SHOWN`). `folded` counts the finished ones that are not drawn. Shared by the
 * event-stream aggregator and the terminal-session reader so both views age their agents the same way.
 */
export function selectVisibleAgents<T extends TimedAgent>(agents: readonly T[], at: number): { live: T[]; shown: T[]; folded: number } {
  const live = agents.filter((agent) => isLiveState(agent.state)).sort((a, b) => a.startedAt - b.startedAt);
  const finished = agents
    .filter((agent) => !isLiveState(agent.state))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const shownFinished = finished
    .filter((agent) => at - (agent.endedAt ?? 0) <= FINISHED_VISIBLE_MS)
    .slice(0, MAX_FINISHED_SHOWN);
  return { live, shown: [...live, ...shownFinished], folded: finished.length - shownFinished.length };
}
