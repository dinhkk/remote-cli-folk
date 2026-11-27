import { isSameFolder } from '@/shared/utils';
import type { ClaudeAgentEntry, GenerateTargetProject, MemoryBlock } from '@/shared/types';

/**
 * The sidebar project whose folder is `directory` (folders compared however they were typed); null when it is not in the
 * sidebar (any more). Used by the folder list of a project block to show the project's name next to the folder.
 */
export function projectOfDirectory(projects: readonly GenerateTargetProject[], directory: string): GenerateTargetProject | null {
  return projects.find((project) => isSameFolder(project.directory, directory)) ?? null;
}

/**
 * Translation key (and its `name` value) that says in words who wrote a block last: nobody yet, the user, or an agent by
 * name (`lastWriter` is null, `user` or `agent:<name>`). Used by the block row and the stale-save notice of the form.
 */
export function writerWords(lastWriter: string | null): { key: 'memory.writerNone' | 'memory.writerUser' | 'memory.writerAgent'; name: string } {
  if (lastWriter === null) return { key: 'memory.writerNone', name: '' };
  if (lastWriter === 'user') return { key: 'memory.writerUser', name: '' };
  return { key: 'memory.writerAgent', name: lastWriter.startsWith('agent:') ? lastWriter.slice('agent:'.length) : lastWriter };
}

/** Whether a tool list entry is Bash itself or a Bash permission pattern such as `Bash(git:*)`. */
const isBashTool = (tool: string): boolean => tool === 'Bash' || tool.startsWith('Bash(');

/**
 * The agents of the loaded list that can bypass a read-only block: agent files (the built-ins' tools are unknown, so they
 * are not judged) that are not hidden and either list Bash in `tools:` or have no `tools:` restriction at all. The
 * list is the one the Agents tab loaded for its target, not one per block scope, so this over-reports for project
 * blocks of other projects; the Memory tab says so.
 * Used by the Memory tab for the "read-only is not a hard lock" notice.
 */
export function agentsThatCanBypassLock(entries: readonly ClaudeAgentEntry[]): ClaudeAgentEntry[] {
  return entries.filter((entry) => (
    entry.source !== 'builtin'
    && !entry.error
    && !entry.hidden
    && (!entry.tools || entry.tools.length === 0 || entry.tools.some(isBashTool))
  ));
}

/** Whether the lock notice applies to a block: only read-only blocks have a lock to warn about. */
export const showsLockWarning = (block: Pick<MemoryBlock, 'mode'>, risky: readonly ClaudeAgentEntry[]): boolean =>
  block.mode === 'read-only' && risky.length > 0;
