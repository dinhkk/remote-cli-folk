import type { GenerateTargetProject } from '@/shared/types';

/** Target id of the global scope (`~/.claude/agents`); every other id is a sidebar project's id. */
export const GLOBAL_TARGET_ID = '';

/** Where Generate writes and the agent list reads: a sidebar project's folder, or `directory: null` for `~/.claude/agents`. */
export type GenerateTarget = { directory: string | null; projectName: string };

/**
 * Resolves a target id against the sidebar projects: the project (null for the global scope) and the target to
 * hand to the list and the Generate form. An id that is no longer a project (it was removed from the sidebar) resolves to the global scope.
 * Used by the agent-profiles panel and the Agents tab.
 */
export function resolveGenerateTarget(
  projects: readonly GenerateTargetProject[],
  targetId: string,
): { project: GenerateTargetProject | null; target: GenerateTarget } {
  const project = projects.find((candidate) => candidate.projectId === targetId) ?? null;
  return {
    project,
    target: project ? { directory: project.directory, projectName: project.name } : { directory: null, projectName: '' },
  };
}
