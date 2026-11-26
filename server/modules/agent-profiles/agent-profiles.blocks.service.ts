import { AppError } from '@/shared/utils.js';
import type {
  MemoryBlock, MemoryBlockDefinition, MemoryBlockProjectContent, MemoryBlockWriter,
} from '@/shared/types.js';

import {
  MAX_MEMORY_BLOCKS, isValidBlockName, parseBlockInput, parseExpectedBlockRev,
} from './agent-profiles.blocks.validation.js';
import { blockContentKey, blockFolderOf, type AgentProfileStore } from './agent-profiles.store.js';
import { parseDirectory } from './agent-profiles.validation.js';

const KIND = 'memory-blocks';
/** Where the definitions of blocks saved before per-folder content are copied to before they are rewritten (inside the store root). */
const LEGACY_BACKUP_DIR = 'memory-blocks.legacy';

const notFound = (): AppError => new AppError('Memory block not found', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
const conflict = (message: string, code: string): AppError => new AppError(message, { code, statusCode: 409 });
const isCorrupt = (error: unknown): error is AppError => error instanceof AppError && error.code === 'PROFILE_CORRUPT';

/** A block saved by an older version still carries the one folder it belonged to in `scope.directory`. */
const legacyDirectoryOf = (definition: MemoryBlockDefinition): string | null => {
  const directory = (definition.scope as { directory?: unknown }).directory;
  return definition.scope.kind === 'project' && typeof directory === 'string' && directory ? directory : null;
};

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** What an agent run asks for: the project folder the run works in (null/absent: only global blocks) and the main agent's name. */
export type BlocksRunContext = { directory: string | null | undefined; agentName: string };

/** The two ways an agent can change a block: set its whole content, or add a line after it. */
export type BlockWriteHow = 'replace' | 'append';

/** One block as a run sees it. `legacy`: still the unmigrated record of an old folder-bound block (content lives in the record). */
type VisibleEntry = { block: MemoryBlock; definition: MemoryBlockDefinition; legacy: boolean };

/**
 * App-owned memory blocks: CRUD for the user (REST) and the narrow read/write path the `blocks` MCP server gives
 * agents. Every rule lives here: valid names, unique across all scopes, at most 50 definitions, content within
 * `maxChars`, `read-only` blocks writable by the user only, stale edits refused (409, `rev`). A global block keeps its text
 * in its record; a project block is one definition with a content file per folder, and an agent sees it only in a
 * folder that has such a file (created by the user, never by an agent). Blocks saved by an older version (bound to one
 * folder) are moved to per-folder content on first use (and again after a failed run or a block create, rename or delete), see `migrateLegacyBlocks`. Persistence is the store's.
 * Consumed by: agent-profiles.routes.ts, agent-profiles.blocks.mcp.ts (via agent-profiles.module.ts).
 */
export function createBlocksService(dependencies: { store: AgentProfileStore }) {
  const { store } = dependencies;

  /** Why a block saved by an older version could not be moved (by id); filled by the migration, in memory only. */
  let attention = new Map<string, string>();
  /** True until a migration run has covered the current records; set again by a failed listing and by every block create, rename or delete. */
  let migrationPending = true;

  const attentionOf = (definition: MemoryBlockDefinition): string | undefined =>
    legacyDirectoryOf(definition) === null
      ? undefined
      : attention.get(definition.id) ?? 'Saved by an older version and not yet moved to per-folder content.';

  /** The definition as the owner sees it: no stored folder, plus the migration note when it could not be moved. */
  function publicDefinition(definition: MemoryBlockDefinition): MemoryBlockDefinition {
    const note = attentionOf(definition);
    return { ...definition, scope: definition.scope.kind === 'global' ? { kind: 'global' } : { kind: 'project' }, ...(note ? { needsAttention: note } : {}) };
  }

  /**
   * Moves every block saved by an older version (`{kind:'project', directory}`) to per-folder content: the definition becomes
   * `{kind:'project'}` and the old folder gets a content file with the block's text, `rev`, writer and time. Safe to run again
   * (a finished block is skipped) and per record: a failure only flags that block (`needsAttention`), it stays visible in its old
   * folder, and nothing else is aborted. A block whose name another block also uses is not moved (names are unique across
   * scopes now; the global one wins elsewhere). The old definition is copied to `memory-blocks.legacy/` before anything is
   * written. Never throws.
   */
  function migrateLegacyBlocks(): void {
    migrationPending = false;
    const notes = new Map<string, string>();
    try {
      const { items } = store.list<MemoryBlockDefinition>(KIND);
      const nameCounts = new Map<string, number>();
      for (const item of items) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
      for (const definition of items) {
        const legacyDirectory = legacyDirectoryOf(definition);
        if (legacyDirectory === null) continue;
        try {
          if ((nameCounts.get(definition.name) ?? 0) > 1) {
            notes.set(definition.id, `The name "${definition.name}" is also used by another memory block, so it was not moved to per-folder content. Rename one of them.`);
            continue;
          }
          const { directory, key } = blockFolderOf(legacyDirectory);
          store.backupRecord(KIND, definition.id, LEGACY_BACKUP_DIR);
          // An existing content file (an earlier, interrupted run) must be readable, otherwise this block is left alone.
          if (!store.getContent(definition.id, key)) {
            store.createContent(definition.id, key, {
              directory, content: definition.content, lastWriter: definition.lastWriter, rev: definition.rev, updatedAt: definition.updatedAt,
            });
          }
          store.update<MemoryBlockDefinition>(KIND, definition.id, definition.rev, (current) => ({
            name: current.name, description: current.description, mode: current.mode, scope: { kind: 'project' },
            content: '', maxChars: current.maxChars, lastWriter: null,
          }));
        } catch (error) {
          console.warn(`[agent-profiles] memory block ${definition.id} was not moved to per-folder content:`, error);
          notes.set(definition.id, `Could not be moved to per-folder content: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      // The records could not even be listed (EACCES, EMFILE ...): nothing was judged, so the next access tries again.
      migrationPending = true;
      console.warn('[agent-profiles] memory block migration failed:', error);
    }
    attention = notes;
  }

  const ensureMigrated = (): void => {
    if (migrationPending) migrateLegacyBlocks();
  };

  /** Readable definitions (after any pending migration), sorted by name. Unreadable files are skipped, never replaced. */
  function definitions(): MemoryBlockDefinition[] {
    ensureMigrated();
    return store.list<MemoryBlockDefinition>(KIND).items.sort(byName);
  }

  function requireDefinition(id: string): MemoryBlockDefinition {
    ensureMigrated();
    const found = store.get<MemoryBlockDefinition>(KIND, id);
    if (!found) throw notFound();
    return found;
  }

  /** A project definition that has been moved to per-folder content (the only kind that owns content files). */
  function requireProjectDefinition(id: string): MemoryBlockDefinition {
    const definition = requireDefinition(id);
    if (definition.scope.kind !== 'project') {
      throw new AppError('Only a project memory block has content per folder', { code: 'BLOCK_NOT_PROJECT_SCOPE', statusCode: 400 });
    }
    if (legacyDirectoryOf(definition) !== null) {
      // Try once more (a transient failure or a clash may be over); only a block that is still not moved is refused.
      migrateLegacyBlocks();
      const retried = store.get<MemoryBlockDefinition>(KIND, id);
      if (retried && legacyDirectoryOf(retried) === null) return retried;
      throw conflict('This memory block was saved by an older version and could not be moved to per-folder content yet', 'BLOCK_NOT_MIGRATED');
    }
    return definition;
  }

  /** `directory` of a user request as the folder + key every content path uses; 400 when missing or not absolute. */
  function folderOfRequest(directory: unknown): { directory: string; key: string } {
    const parsed = parseDirectory(directory, 'directory');
    if (!parsed) throw new AppError('directory is required', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
    return blockFolderOf(parsed);
  }

  function viewOf(definition: MemoryBlockDefinition, content: MemoryBlockProjectContent | null): MemoryBlock {
    const note = attentionOf(definition);
    const base = { ...definition, scope: publicDefinition(definition).scope, definitionRev: definition.rev };
    const view = content
      ? { ...base, content: content.content, rev: content.rev, lastWriter: content.lastWriter, updatedAt: content.updatedAt }
      : base;
    return note ? { ...view, needsAttention: note } : view;
  }

  /**
   * Blocks an agent run in `directory` sees: global ones, project blocks with a content file for exactly that folder, and
   * unmigrated old blocks of that folder. A block whose content file is unreadable is left out (and listed in `corrupt`);
   * the others are not affected.
   */
  function visibleEntries(directory: string | null | undefined): { entries: VisibleEntry[]; corrupt: { id: string; error: string }[] } {
    const key = directory?.trim() ? blockContentKey(directory) : null;
    const entries: VisibleEntry[] = [];
    const corrupt: { id: string; error: string }[] = [];
    for (const definition of definitions()) {
      if (definition.scope.kind === 'global') {
        entries.push({ block: viewOf(definition, null), definition, legacy: false });
        continue;
      }
      if (key === null) continue;
      const legacyDirectory = legacyDirectoryOf(definition);
      if (legacyDirectory !== null) {
        if (blockContentKey(legacyDirectory) === key) entries.push({ block: viewOf(definition, null), definition, legacy: true });
        continue;
      }
      try {
        const content = store.getContent(definition.id, key);
        if (content) entries.push({ block: viewOf(definition, content), definition, legacy: false });
      } catch (error) {
        if (!isCorrupt(error)) throw error;
        console.warn(`[agent-profiles] content of memory block ${definition.id} is unreadable:`, error.message);
        corrupt.push({ id: definition.id, error: error.message });
      }
    }
    return { entries, corrupt };
  }

  /**
   * The visible block with this name. An old folder-bound block that was not moved (name clash) wins in its own folder, as it
   * always did; otherwise a global block wins over a project one of the same name.
   */
  function findVisible(directory: string | null | undefined, name: string): VisibleEntry | null {
    if (!isValidBlockName(name)) return null;
    const matches = visibleEntries(directory).entries.filter((entry) => entry.block.name === name);
    return matches.find((entry) => entry.legacy)
      ?? matches.find((entry) => entry.block.scope.kind === 'global')
      ?? matches[0]
      ?? null;
  }

  /** The visible block by name, or a `BLOCK_NOT_FOUND` that never names blocks of other projects. */
  function readVisible(directory: string | null | undefined, name: string): VisibleEntry {
    const entry = findVisible(directory, name);
    if (!entry) throw new AppError(`No memory block named "${name}"`, { code: 'BLOCK_NOT_FOUND', statusCode: 404 });
    return entry;
  }

  /**
   * Refuses a name another block already uses in ANY scope: an agent asks for a block by name alone, so two blocks of one
   * name would hide each other. `selfId` is the block being edited.
   */
  function refuseTakenName(name: string, selfId?: string): void {
    if (definitions().some((definition) => definition.id !== selfId && definition.name === name)) {
      throw conflict(
        `A memory block named "${name}" already exists. Block names are unique across global and all project scopes; pick another name.`,
        'BLOCK_NAME_TAKEN',
      );
    }
  }

  const refuseTooLarge = (definition: MemoryBlockDefinition, length: number): void => {
    if (length > definition.maxChars) {
      throw new AppError(
        `Memory block "${definition.name}" holds at most ${definition.maxChars} characters; the result would be ${length}. Shorten the text or replace the block.`,
        { code: 'BLOCK_TOO_LARGE', statusCode: 400 },
      );
    }
  };

  return {
    // ---------- user (REST) ----------
    /** Every readable block definition of every scope (the owner's management list); no per-folder content. */
    list: (): { blocks: MemoryBlockDefinition[] } => ({ blocks: definitions().map(publicDefinition) }),

    /** `writer` labels the text of a global block created with content (default: the user; the bundle importer passes the provenance it keeps). */
    create(body: unknown, writer: Exclude<MemoryBlockWriter, null> = 'user'): { block: MemoryBlockDefinition } {
      const input = parseBlockInput(body);
      if (definitions().length >= MAX_MEMORY_BLOCKS) {
        throw conflict(`At most ${MAX_MEMORY_BLOCKS} memory blocks can exist; delete one first`, 'BLOCK_LIMIT_REACHED');
      }
      refuseTakenName(input.name);
      const block = store.insert<MemoryBlockDefinition>(KIND, { ...input, lastWriter: input.scope.kind === 'global' && input.content ? writer : null });
      migrationPending = true; // a new name may clash with a block that is waiting to be moved
      return { block: publicDefinition(block) };
    },

    /**
     * Replaces a block's definition fields; `expectedRev` must be the definition revision the editor loaded (409 otherwise).
     * The user may edit read-only blocks. The scope kind cannot change (409), a project definition ignores `content` (its
     * text lives per folder). Only a rename is checked for a taken name: a block that already shares its name with another
     * (stored before names became unique across scopes) stays editable, it just cannot be renamed into a clash.
     * `writer` labels a changed global text (default: the user).
     */
    update(id: string, body: unknown, writer: Exclude<MemoryBlockWriter, null> = 'user'): { block: MemoryBlockDefinition } {
      const input = parseBlockInput(body, { requireContent: true });
      const expectedRev = parseExpectedBlockRev(body);
      const existing = requireDefinition(id);
      if (input.scope.kind !== existing.scope.kind) {
        throw conflict('The scope of a memory block cannot be changed; create a new block instead', 'BLOCK_SCOPE_IMMUTABLE');
      }
      if (input.name !== existing.name) refuseTakenName(input.name, id);
      const block = store.update<MemoryBlockDefinition>(KIND, id, expectedRev, (current) => (
        current.scope.kind === 'project'
          ? { ...input, scope: current.scope, content: current.content, lastWriter: current.lastWriter }
          : { ...input, lastWriter: input.content !== current.content ? writer : current.lastWriter }
      ));
      migrationPending = true; // a rename may end (or start) a name clash
      return { block: publicDefinition(block) };
    },

    /** Deletes the content files first, then the definition, so a retry after a crash finds the definition and finishes. */
    remove(id: string): { ok: true } {
      ensureMigrated();
      store.removeAllContents(id);
      const removed = store.remove(KIND, id);
      migrationPending = true; // the removed block may have been the other side of a name clash
      if (!removed) throw notFound();
      return { ok: true };
    },

    /** Folders a project block has content for (host view), plus unreadable content files. */
    listContents(id: string): { contents: MemoryBlockProjectContent[]; corrupt: { id: string; error: string }[] } {
      requireProjectDefinition(id);
      const { items, corrupt } = store.listContents(id);
      return { contents: items, corrupt };
    },

    /** Gives the folder an empty content file, which makes the block visible to agents there (409 when it already has one, or at the cap). */
    addContent(id: string, directory: unknown): { content: MemoryBlockProjectContent } {
      requireProjectDefinition(id);
      const folder = folderOfRequest(directory);
      return { content: store.createContent(id, folder.key, { directory: folder.directory, content: '', lastWriter: null }) };
    },

    /**
     * Import of one folder's text in a single write: without `expectedRev` the file is created with its text (`rev` 1, or the
     * removed file's last rev + 1; 409 `BLOCK_CONTENT_EXISTS` when it exists, `BLOCK_CONTENT_LIMIT_REACHED` at the cap); with
     * `expectedRev` the existing file is rewritten (409 `PROFILE_STALE` when its rev moved on). `directory` is a folder the
     * caller already trusts (a sidebar project's folder, or one this server wrote into a snapshot), never a request value.
     * `writer` is the provenance label of the text.
     * Consumed by: agent-profiles.bundle.service.ts.
     */
    importFolderText(
      id: string, directory: string, content: string, options: { writer: Exclude<MemoryBlockWriter, null>; expectedRev?: number },
    ): { content: MemoryBlockProjectContent } {
      const definition = requireProjectDefinition(id);
      const folder = blockFolderOf(directory);
      refuseTooLarge(definition, content.length);
      if (options.expectedRev === undefined) {
        return { content: store.createContent(id, folder.key, { directory: folder.directory, content, lastWriter: options.writer }) };
      }
      return { content: store.updateContent(id, folder.key, options.expectedRev, () => ({ content, lastWriter: options.writer })) };
    },

    /** User edit of a folder's text; `expectedRev` is the content `rev` the editor loaded. */
    updateContent(id: string, directory: unknown, content: string, expectedRev: number): { content: MemoryBlockProjectContent } {
      const definition = requireProjectDefinition(id);
      const folder = folderOfRequest(directory);
      if (typeof content !== 'string') throw new AppError('content must be a string', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
      refuseTooLarge(definition, content.length);
      return { content: store.updateContent(id, folder.key, expectedRev, () => ({ content, lastWriter: 'user' })) };
    },

    /** Empties a folder's text but keeps its file and bumps its `rev` (tools never vanish mid-session; stale edits stay refused). */
    emptyContent(id: string, directory: unknown, expectedRev?: number): { content: MemoryBlockProjectContent } {
      requireProjectDefinition(id);
      const folder = folderOfRequest(directory);
      const rev = expectedRev ?? store.getContent(id, folder.key)?.rev;
      if (rev === undefined) throw new AppError('No content for this folder', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
      return { content: store.updateContent(id, folder.key, rev, () => ({ content: '', lastWriter: 'user' })) };
    },

    /**
     * Removes the folder from the block: deletes its file (the last `rev` is kept so a later create counts on). 404 when it has none.
     * With `expectedRev` a file whose `rev` moved on is kept (409); an unreadable file can still be removed.
     */
    removeFolder(id: string, directory: unknown, expectedRev?: number): { ok: true } {
      requireProjectDefinition(id);
      const folder = folderOfRequest(directory);
      if (expectedRev !== undefined) {
        let current: MemoryBlockProjectContent | null = null;
        try {
          current = store.getContent(id, folder.key);
        } catch (error) {
          if (!isCorrupt(error)) throw error;
        }
        if (current && current.rev !== expectedRev) {
          throw new AppError('This content was changed since you loaded it. Reload and try again.', {
            code: 'PROFILE_STALE', statusCode: 409, details: { currentRev: current.rev, currentUpdatedAt: current.updatedAt },
          });
        }
      }
      if (!store.removeContent(id, folder.key)) throw new AppError('No content for this folder', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
      return { ok: true };
    },

    migrateLegacyBlocks,

    // ---------- agent (MCP) ----------
    /** Blocks the run may see (global + project blocks with content in its folder). */
    listForRun: (context: Pick<BlocksRunContext, 'directory'>): MemoryBlock[] =>
      visibleEntries(context.directory).entries.map((entry) => entry.block).sort(byName),

    /** Blocks whose content file in the run's folder is unreadable (hidden from the run), for the owner to fix. */
    corruptForRun: (context: Pick<BlocksRunContext, 'directory'>): { id: string; error: string }[] => visibleEntries(context.directory).corrupt,

    /**
     * Whether `directory` (exact folder, same key as everywhere) has at least one project block visible: a content file
     * (an empty one counts). Global blocks do not count: a plain chat gets the blocks server only where the user has set up
     * project memory.
     */
    hasProjectContent: (directory: string | null | undefined): boolean =>
      Boolean(directory?.trim()) && visibleEntries(directory).entries.some((entry) => entry.block.scope.kind === 'project'),

    /** One visible block by name. */
    readForRun: (context: Pick<BlocksRunContext, 'directory'>, name: string): MemoryBlock => readVisible(context.directory, name).block,

    /**
     * Agent write: `replace` sets the content, `append` adds a new line after it. Refused (nothing written) for a
     * `read-only` block, when `expectedRev` is given and is no longer the block's `rev` (`BLOCK_STALE`: the agent
     * must read again), for an empty append, and when the result would pass `maxChars` (nothing is cut).
     * Without `expectedRev` the write goes through on the current content. Records `agent:<agentName>` as the writer.
     * A project block is written in the run's folder only, in a content file that already exists (never created here).
     */
    writeForRun(context: BlocksRunContext, name: string, content: string, how: BlockWriteHow, expectedRev?: number): MemoryBlock {
      const { block, definition, legacy } = readVisible(context.directory, name);
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
      refuseTooLarge(definition, next.length);
      const lastWriter = `agent:${context.agentName}` as const;
      // Read and write run in one synchronous step, so `rev` cannot change in between; a stale edit would still be refused.
      if (definition.scope.kind === 'project' && !legacy) {
        const written = store.updateContent(definition.id, blockContentKey(context.directory as string), block.rev, () => ({ content: next, lastWriter }));
        return viewOf(definition, written);
      }
      const updated = store.update<MemoryBlockDefinition>(KIND, definition.id, block.rev, (current) => ({
        name: current.name, description: current.description, mode: current.mode, scope: current.scope,
        maxChars: current.maxChars, content: next, lastWriter,
      }));
      return viewOf(updated, null);
    },
  };
}

/** Service type the routes and the MCP server depend on. Consumed by: agent-profiles.routes.ts, agent-profiles.blocks.mcp.ts. */
export type BlocksService = ReturnType<typeof createBlocksService>;
