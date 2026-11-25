import { normalizeProjectPath } from '@/shared/utils.js';
import type { AgentMonitorProject, AgentMonitorSession } from '@/shared/types.js';

import { isLiveState } from './agent-monitor.visibility.js';

/** The key sessions with no known folder are grouped under. */
export const NO_FOLDER_KEY = 'no-folder';

/** Windows-style paths (drive letter or UNC) compare case-insensitively; POSIX paths do not. */
const isWindowsPath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');

/**
 * The grouping key of a folder: the normalised path, lower-cased on Windows (where `C:\x` and `c:\X` are one folder).
 * The same key joins an app chat and a terminal session that run in the same folder.
 */
export function projectKeyOf(folder: string | null | undefined): string {
  if (!folder) return NO_FOLDER_KEY;
  const normalised = normalizeProjectPath(folder);
  if (!normalised) return NO_FOLDER_KEY;
  return isWindowsPath(normalised) ? normalised.toLowerCase() : normalised;
}

/** The last segment of a folder path (`C:\a\Alpha-ext` -> `Alpha-ext`), null when there is none. */
export function folderNameOf(folder: string | null | undefined): string | null {
  if (!folder) return null;
  // Either separator: `normalizeProjectPath` writes backslashes on a Windows host even for a POSIX-looking path.
  return normalizeProjectPath(folder).split(/[\\/]/).filter(Boolean).pop() ?? null;
}

const STATE_RANK: Record<AgentMonitorProject['state'], number> = { waiting: 0, running: 1, idle: 2 };

/**
 * Groups sessions by project. A project is `running` only while one of its sessions is running or waiting (an idle
 * session, kept visible for a short while after it finished, does not make its project count as running). Projects are
 * ordered waiting, running, then idle, and inside a state by the most recent session activity; `sessionIds` follows the
 * order of `sessions`, which the caller has already sorted busiest first.
 */
export function groupSessionsByProject(sessions: readonly AgentMonitorSession[]): AgentMonitorProject[] {
  const groups = new Map<string, { project: AgentMonitorProject; lastEventAt: number }>();

  for (const session of sessions) {
    let group = groups.get(session.projectKey);
    if (!group) {
      group = {
        project: {
          key: session.projectKey,
          name: session.projectName ?? folderNameOf(session.projectPath) ?? '',
          path: session.projectPath,
          state: 'idle',
          runningSessions: 0,
          runningAgents: 0,
          tokens: 0,
          sessionIds: [],
        },
        lastEventAt: 0,
      };
      groups.set(session.projectKey, group);
    }
    const { project } = group;
    // The first session that knows the folder's name or path names the project.
    if (!project.name && session.projectName) project.name = session.projectName;
    if (!project.path && session.projectPath) project.path = session.projectPath;

    project.sessionIds.push(session.id);
    project.tokens += session.agentTokens;
    project.runningAgents += session.agents.filter((agent) => isLiveState(agent.state)).length;
    if (session.state !== 'idle') project.runningSessions += 1;
    if (session.state === 'waiting') project.state = 'waiting';
    else if (session.state === 'running' && project.state !== 'waiting') project.state = 'running';
    group.lastEventAt = Math.max(group.lastEventAt, session.lastEventAt);
  }

  return [...groups.values()]
    .sort((a, b) => STATE_RANK[a.project.state] - STATE_RANK[b.project.state] || b.lastEventAt - a.lastEventAt)
    .map(({ project }) => project);
}
