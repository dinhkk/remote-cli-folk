import { AppError, normalizeProjectPath } from '@/shared/utils.js';
import type { MemoryBlock, MemoryBlockScope } from '@/shared/types.js';

import {
  MAX_MEMORY_BLOCKS, isValidBlockName, parseBlockInput, parseExpectedBlockRev,
} from './agent-profiles.blocks.validation.js';
import { valuesKeyOf, type AgentProfileStore } from './agent-profiles.store.js';

const KIND = 'memory-blocks';

const notFound = (): AppError => new AppError('Memory block not found', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
const conflict = (message: string, code: string): AppError => new AppError(message, { code, statusCode: 409 });

/** Key of a block's scope; the same key `valuesKeyOf` gives the project folder, so differently typed paths of one folder agree. */
const scopeKeyOf = (scope: MemoryBlockScope): string => valuesKeyOf(scope.kind === 'project' ? scope.directory : null);

const byName = (a: MemoryBlock, b: MemoryBlock): number => a.name.localeCompare(b.name) || scopeKeyOf(a.scope).localeCompare(scopeKeyOf(b.scope));

/** What an agent run asks for: the project folder the run works in (null/absent: only global blocks) and the main agent's name. */
export type BlocksRunContext = { directory: string | null | undefined; agentName: string };

/** The two ways an agent can change a block: set its whole content, or add a line after it. */
export type BlockWriteHow = 'replace' | 'append';

/**
 * App-owned memory blocks: CRUD for the user (REST) and the narrow read/write path the `blocks` MCP server
 * gives agents. Every rule lives here: valid names, unique across all scopes, at most 50 blocks, content within
 * `maxChars`, `read-only` blocks writable by the user only, stale edits refused (409, `rev`), and an agent
 * seeing only the global blocks plus those of its own project folder. Persistence is the store's.
 * Consumed by: agent-profiles.routes.ts, agent-profiles.blocks.mcp.ts (via agent-profiles.module.ts).
 */
export function createBlocksService(dependencies: { store: AgentProfileStore }) {
  const { store } = dependencies;

  const allBlocks = (): MemoryBlock[] => store.list<MemoryBlock>(KIND).items.sort(byName);

  function requireBlock(id: string): MemoryBlock {
    const found = store.get<MemoryBlock>(KIND, id);
    if (!found) throw notFound();
    return found;
  }

  /**
   * Refuses a name another block already uses in ANY scope (global or any project): an agent asks for a block by
   * name alone, so two blocks of one name would hide each other. `selfId` is the block being edited.
   */
  function refuseTakenName(name: string, selfId?: string): void {
    if (allBlocks().some((block) => block.id !== selfId && block.name === name)) {
      throw conflict(
        `A memory block named "${name}" already exists. Block names are unique across global and all project scopes; pick another name.`,
        'BLOCK_NAME_TAKEN',
      );
    }
  }

  /** Blocks an agent run in `directory` may see: global ones plus those of exactly that project folder. */
  function visibleTo(directory: string | null | undefined): MemoryBlock[] {
    const key = valuesKeyOf(directory ? normalizeProjectPath(directory) : null);
    return allBlocks().filter((block) => block.scope.kind === 'global' || scopeKeyOf(block.scope) === key);
  }

  /**
   * The visible block with this name. Names are unique across scopes for new blocks; blocks stored before that rule
   * may still share a name, and then the project block wins over the global one.
   */
  function findVisible(directory: string | null | undefined, name: string): MemoryBlock | null {
    if (!isValidBlockName(name)) return null;
    const matches = visibleTo(directory).filter((block) => block.name === name);
    return matches.find((block) => block.scope.kind === 'project') ?? matches[0] ?? null;
  }

  /** The visible block by name, or a `BLOCK_NOT_FOUND` that never names blocks of other projects. */
  function readVisible(directory: string | null | undefined, name: string): MemoryBlock {
    const block = findVisible(directory, name);
    if (!block) throw new AppError(`No memory block named "${name}"`, { code: 'BLOCK_NOT_FOUND', statusCode: 404 });
    return block;
  }

  return {
    // ---------- user (REST) ----------
    /** Every readable block of every scope (the owner's management list). Unreadable files are skipped, never replaced. */
    list: (): { blocks: MemoryBlock[] } => ({ blocks: allBlocks() }),

    create(body: unknown): { block: MemoryBlock } {
      const input = parseBlockInput(body);
      if (allBlocks().length >= MAX_MEMORY_BLOCKS) {
        throw conflict(`At most ${MAX_MEMORY_BLOCKS} memory blocks can exist; delete one first`, 'BLOCK_LIMIT_REACHED');
      }
      refuseTakenName(input.name);
      return { block: store.insert<MemoryBlock>(KIND, { ...input, lastWriter: input.content ? 'user' : null }) };
    },

    /**
     * Replaces a block's editable fields; `expectedRev` must be the revision the editor loaded (409 otherwise). The user
     * may edit read-only blocks. Only a rename is checked for a taken name: a block that already shares its name with
     * another (stored before names became unique across scopes) stays editable, it just cannot be renamed into a clash.
     */
    update(id: string, body: unknown): { block: MemoryBlock } {
      const input = parseBlockInput(body, { requireContent: true });
      const expectedRev = parseExpectedBlockRev(body);
      const existing = requireBlock(id);
      if (input.name !== existing.name) refuseTakenName(input.name, id);
      const block = store.update<MemoryBlock>(KIND, id, expectedRev, (current) => ({
        ...input,
        lastWriter: input.content !== current.content ? 'user' : current.lastWriter,
      }));
      return { block };
    },

    remove(id: string): { ok: true } {
      if (!store.remove(KIND, id)) throw notFound();
      return { ok: true };
    },

    // ---------- agent (MCP) ----------
    /** Blocks the run may see (global + its project folder). */
    listForRun: (context: Pick<BlocksRunContext, 'directory'>): MemoryBlock[] => visibleTo(context.directory),

    /**
     * Whether `directory` (exact folder, same rule as `visibleTo`) owns at least one project block. Global blocks
     * do not count: a plain chat gets the blocks server only where the user has set up project memory.
     */
    hasProjectBlocks: (directory: string | null | undefined): boolean =>
      Boolean(directory) && visibleTo(directory).some((block) => block.scope.kind === 'project'),

    /** One visible block by name; a project block wins over a global one of the same name. */
    readForRun: (context: Pick<BlocksRunContext, 'directory'>, name: string): MemoryBlock => readVisible(context.directory, name),

    /**
     * Agent write: `replace` sets the content, `append` adds a new line after it. Refused (nothing written) for a
     * `read-only` block, when `expectedRev` is given and is no longer the block's `rev` (`BLOCK_STALE`: the agent
     * must read again), for an empty append, and when the result would pass `maxChars` (nothing is cut).
     * Without `expectedRev` the write goes through on the current content. Records `agent:<agentName>` as the writer.
     */
    writeForRun(context: BlocksRunContext, name: string, content: string, how: BlockWriteHow, expectedRev?: number): MemoryBlock {
      const block = readVisible(context.directory, name);
      if (block.mode === 'read-only') {
        throw new AppError(`Memory block "${name}" is read-only: only the user can change it`, { code: 'BLOCK_READ_ONLY', statusCode: 403 });
      }
      if (expectedRev !== undefined && expectedRev !== block.rev) {
        throw new AppError(
          `Memory block "${name}" changed after you read it (you have rev ${expectedRev}, it is now rev ${block.rev}); nothing was written. Call block_read again, then write.`,
          { code: 'BLOCK_STALE', statusCode: 409 },
        );
      }
      if (how === 'append' && content === '') {
        throw new AppError(`Nothing to append to memory block "${name}": content is empty`, { code: 'BLOCK_EMPTY_APPEND', statusCode: 400 });
      }
      const next = how === 'append' && block.content ? `${block.content}\n${content}` : content;
      if (next.length > block.maxChars) {
        throw new AppError(
          `Memory block "${name}" holds at most ${block.maxChars} characters; the result would be ${next.length}. Shorten the text or replace the block.`,
          { code: 'BLOCK_TOO_LARGE', statusCode: 400 },
        );
      }
      // Read and write run in one synchronous step, so `rev` cannot change in between; a stale edit would still be refused.
      return store.update<MemoryBlock>(KIND, block.id, block.rev, (current) => ({
        name: current.name, description: current.description, mode: current.mode, scope: current.scope,
        maxChars: current.maxChars, content: next, lastWriter: `agent:${context.agentName}`,
      }));
    },
  };
}

/** Service type the routes and the MCP server depend on. Consumed by: agent-profiles.routes.ts, agent-profiles.blocks.mcp.ts. */
export type BlocksService = ReturnType<typeof createBlocksService>;
