import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError, assertValidProfileId, isValidProfileId, normalizeProjectPath } from '@/shared/utils.js';
import type {
  AgentProfileKind,
  AgentProfileList,
  AgentProfileMeta,
  AgentProfileSettings,
  AgentProfileValues,
  MemoryBlockProjectContent,
  MemoryBlockWriter,
  StoredShapeCheck,
} from '@/shared/types.js';

const DEFAULT_SETTINGS: AgentProfileSettings = { rev: 0, updatedAt: '', hiddenClaudeAgents: [] };

/** Key of the global (no project) scope in `values-by-directory.json`; never equal to a normalized folder path. */
const GLOBAL_VALUES_KEY = '@global';

/**
 * Stable key of a project folder in `values-by-directory.json`: the normalized path with `/`
 * separators, lower-cased for Windows-style paths (drive letter or UNC), so the same folder typed
 * differently ("C:\Work\Alpha", "c:/work/alpha/") finds the same values. Empty input is the global key.
 */
export function valuesKeyOf(directory: string | null | undefined): string {
  const normalized = normalizeProjectPath(directory ?? '').split('\\').join('/');
  if (!normalized) return GLOBAL_VALUES_KEY;
  return /^([A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * The folder a project memory block keeps content for: resolved to an absolute path (Windows-style paths are taken as
 * typed: `path.resolve` would graft them onto the server's cwd), normalized, plus its `valuesKeyOf` key. One function for
 * REST, the blocks service and the attach rule, so a folder typed differently always lands on the same file.
 */
export function blockFolderOf(directory: string): { directory: string; key: string } {
  const typed = directory.trim();
  const normalized = normalizeProjectPath(/^([A-Za-z]:|\\\\|\/\/)/.test(typed) ? typed : path.resolve(typed));
  return { directory: normalized, key: valuesKeyOf(normalized) };
}

/** Key of the content file of a folder (see {@link blockFolderOf}). */
export const blockContentKey = (directory: string): string => blockFolderOf(directory).key;

/** Folder of the per-folder contents of project memory blocks, under the store root. */
const CONTENTS_DIR = 'memory-block-contents';
/** At most this many content files (folders) per project block. */
export const MAX_CONTENTS_PER_BLOCK = 200;
const CONTENT_FILE_PATTERN = /^[0-9a-f]{16}\.json$/;

/** File name stem of a folder key: the first 16 hex characters of its sha1. */
const contentHashOf = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 16);

const isWriter = (writer: unknown): writer is MemoryBlockWriter =>
  writer === null || writer === 'user' || (typeof writer === 'string' && writer.startsWith('agent:'));

function corruptError(fileName: string, reason: string): AppError {
  // The file is left untouched so the user can repair or delete it by hand.
  return new AppError(`Stored profile ${fileName} is unreadable: ${reason}`, {
    code: 'PROFILE_CORRUPT', statusCode: 500, details: { file: fileName },
  });
}

/**
 * File-backed JSON store for templates, module settings and the Generate values
 * remembered per folder under `rootDir` (`<rootDir>/<kind>/<id>.json`, `<rootDir>/settings.json`,
 * `<rootDir>/values-by-directory.json`). Old `agents/`, `memory/` and `projects/` folders are ignored.
 *
 * All file work is synchronous on purpose: a read-compare-write sequence then runs
 * without another request interleaving, so the `rev` check cannot race inside one
 * process. Writes go to a temp file and are renamed over the target, so a crash
 * never leaves a half-written record; an unreadable file is reported, never replaced.
 *
 * Consumed by: agent-profiles.service.ts and claude-agents.service.ts (hidden list).
 */
export function createAgentProfileStore(options: {
  rootDir: string;
  checkShape: StoredShapeCheck;
  now?: () => Date;
}) {
  const { rootDir, checkShape } = options;
  const now = options.now ?? (() => new Date());
  const settingsFile = path.join(rootDir, 'settings.json');
  const valuesFile = path.join(rootDir, 'values-by-directory.json');

  function writeAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.renameSync(tempFile, file);
    } catch (error) {
      fs.rmSync(tempFile, { force: true });
      throw error;
    }
  }

  /** Parsed file content, or null when the file does not exist. Invalid JSON throws PROFILE_CORRUPT. */
  function readJson(file: string): unknown | null {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw corruptError(path.basename(file), (error as Error).message);
    }
  }

  function readRecord<T extends AgentProfileMeta>(kind: AgentProfileKind, id: string): T | null {
    const file = path.join(rootDir, kind, `${id}.json`);
    const value = readJson(file);
    if (value === null) return null;
    const problem = checkShape(kind, value);
    const parsed = value as Partial<AgentProfileMeta>;
    if (problem || parsed.id !== id || !Number.isInteger(parsed.rev)) {
      throw corruptError(`${id}.json`, problem ?? 'id or rev does not match the file');
    }
    return value as T;
  }

  function readSettings(): AgentProfileSettings {
    const value = readJson(settingsFile);
    if (value === null) return { ...DEFAULT_SETTINGS };
    const parsed = value as Partial<AgentProfileSettings>;
    if (
      typeof value !== 'object' || !Number.isInteger(parsed.rev)
      || !Array.isArray(parsed.hiddenClaudeAgents) || parsed.hiddenClaudeAgents.some((name) => typeof name !== 'string')
    ) throw corruptError('settings.json', 'unexpected shape');
    return parsed as AgentProfileSettings;
  }

  /** The whole values file ({} when absent); a file of the wrong shape throws PROFILE_CORRUPT and is left alone. */
  function readValuesFile(): Record<string, AgentProfileValues> {
    const value = readJson(valuesFile);
    if (value === null) return {};
    const isMap = (candidate: unknown): candidate is Record<string, unknown> =>
      typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
    const wellFormed = isMap(value)
      && Object.values(value).every((entry) => isMap(entry) && Object.values(entry).every((text) => typeof text === 'string'));
    if (!wellFormed) throw corruptError('values-by-directory.json', 'unexpected shape');
    return value as Record<string, AgentProfileValues>;
  }

  // ---------- per-folder content of project memory blocks ----------

  const contentPathsOf = (blockId: string, key: string) => {
    assertValidProfileId(blockId);
    const directory = path.join(rootDir, CONTENTS_DIR, blockId);
    const hash = contentHashOf(key);
    return { directory, file: path.join(directory, `${hash}.json`), tomb: path.join(directory, `${hash}.tomb`), hash };
  };

  function requireDefinition(blockId: string): void {
    if (!readRecord('memory-blocks', blockId)) {
      throw new AppError('Memory block not found', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
    }
  }

  /** A content file; PROFILE_CORRUPT unless it has the content shape and its `directory` maps back to the file name. */
  function readContentFile(file: string, hash: string): MemoryBlockProjectContent | null {
    const value = readJson(file);
    if (value === null) return null;
    const name = path.basename(file);
    if (typeof value !== 'object' || Array.isArray(value)) throw corruptError(name, 'not an object');
    const record = value as Partial<MemoryBlockProjectContent>;
    if (typeof record.directory !== 'string' || !record.directory || typeof record.content !== 'string'
      || typeof record.updatedAt !== 'string' || !Number.isInteger(record.rev) || (record.rev as number) < 1 || !isWriter(record.lastWriter)) {
      throw corruptError(name, 'unexpected shape');
    }
    if (contentHashOf(valuesKeyOf(record.directory)) !== hash) throw corruptError(name, 'directory does not match the file name');
    return record as MemoryBlockProjectContent;
  }

  /** `rev` a removed content file left in its tomb (0 when none). */
  function readTombRev(tomb: string): number {
    const value = readJson(tomb) as { rev?: unknown } | null;
    if (value === null) return 0;
    if (typeof value !== 'object' || !Number.isInteger(value.rev) || (value.rev as number) < 0) throw corruptError(path.basename(tomb), 'unexpected shape');
    return value.rev as number;
  }

  const contentFileNames = (directory: string): string[] => {
    try {
      return fs.readdirSync(directory).filter((entry) => CONTENT_FILE_PATTERN.test(entry)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };

  return {
    /** Readable records of a collection; broken files are reported in `corrupt`, not thrown. */
    list<T extends AgentProfileMeta>(kind: AgentProfileKind): AgentProfileList<T> {
      const directory = path.join(rootDir, kind);
      let names: string[];
      try {
        names = fs.readdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], corrupt: [] };
        throw error;
      }
      const result: AgentProfileList<T> = { items: [], corrupt: [] };
      for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
        const id = name.slice(0, -'.json'.length);
        if (!isValidProfileId(id)) continue;
        try {
          const record = readRecord<T>(kind, id);
          if (record) result.items.push(record);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'PROFILE_CORRUPT') throw error;
          result.corrupt.push({ id, error: error.message });
        }
      }
      return result;
    },

    /** One record, null when absent; throws PROFILE_CORRUPT for an unreadable file. */
    get<T extends AgentProfileMeta>(kind: AgentProfileKind, id: string): T | null {
      assertValidProfileId(id);
      return readRecord<T>(kind, id);
    },

    /** Creates a record with a fresh id at rev 1. */
    insert<T extends AgentProfileMeta>(kind: AgentProfileKind, content: Omit<T, keyof AgentProfileMeta>): T {
      const record = { ...content, id: randomUUID(), rev: 1, updatedAt: now().toISOString() } as T;
      writeAtomic(path.join(rootDir, kind, `${record.id}.json`), record);
      return record;
    },

    /**
     * Replaces a record's content. `expectedRev` must equal the stored rev, otherwise the
     * write is refused (409) so a newer edit is not lost. `build` receives the current record.
     */
    update<T extends AgentProfileMeta>(
      kind: AgentProfileKind, id: string, expectedRev: number,
      build: (current: T) => Omit<T, keyof AgentProfileMeta>,
    ): T {
      assertValidProfileId(id);
      const current = readRecord<T>(kind, id);
      if (!current) throw new AppError('Profile not found', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
      if (current.rev !== expectedRev) {
        throw new AppError('This record was changed since you loaded it. Reload and try again.', {
          code: 'PROFILE_STALE', statusCode: 409, details: { currentRev: current.rev, currentUpdatedAt: current.updatedAt },
        });
      }
      const next = { ...build(current), id, rev: current.rev + 1, updatedAt: now().toISOString() } as T;
      writeAtomic(path.join(rootDir, kind, `${id}.json`), next);
      return next;
    },

    /** Deletes a record; true when a file was removed. Works on unreadable files too. */
    remove(kind: AgentProfileKind, id: string): boolean {
      assertValidProfileId(id);
      const file = path.join(rootDir, kind, `${id}.json`);
      if (!fs.existsSync(file)) return false;
      fs.rmSync(file);
      return true;
    },

    /** Content of a project block in one folder, null when no file; PROFILE_CORRUPT for an unreadable file. */
    getContent(blockId: string, key: string): MemoryBlockProjectContent | null {
      const paths = contentPathsOf(blockId, key);
      return readContentFile(paths.file, paths.hash);
    },

    /** Readable content files of a block (tombs and temp files ignored); broken ones are reported in `corrupt` (id = file name stem). */
    listContents(blockId: string): { items: MemoryBlockProjectContent[]; corrupt: { id: string; error: string }[] } {
      assertValidProfileId(blockId);
      const directory = path.join(rootDir, CONTENTS_DIR, blockId);
      const result: { items: MemoryBlockProjectContent[]; corrupt: { id: string; error: string }[] } = { items: [], corrupt: [] };
      for (const name of contentFileNames(directory)) {
        const hash = name.slice(0, -'.json'.length);
        try {
          const content = readContentFile(path.join(directory, name), hash);
          if (content) result.items.push(content);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'PROFILE_CORRUPT') throw error;
          result.corrupt.push({ id: hash, error: error.message });
        }
      }
      return result;
    },

    /**
     * Creates the content file of a folder; never replaces one (409 `BLOCK_CONTENT_EXISTS`, also for an unreadable file) and
     * enforces the cap (409 `BLOCK_CONTENT_LIMIT_REACHED`). `rev` is 1, or the last `rev` of a removed file + 1, so a stale
     * edit from before the removal can never match; `init.rev` / `init.updatedAt` carry a migrated block's own values.
     */
    createContent(
      blockId: string, key: string,
      init: { directory: string; content: string; lastWriter: MemoryBlockWriter; rev?: number; updatedAt?: string },
    ): MemoryBlockProjectContent {
      const paths = contentPathsOf(blockId, key);
      requireDefinition(blockId);
      if (valuesKeyOf(init.directory) !== key) {
        throw new AppError('directory does not match the content key', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
      }
      if (fs.existsSync(paths.file)) {
        throw new AppError('This folder already has content for the memory block', { code: 'BLOCK_CONTENT_EXISTS', statusCode: 409 });
      }
      if (contentFileNames(paths.directory).length >= MAX_CONTENTS_PER_BLOCK) {
        throw new AppError(`A memory block can have content for at most ${MAX_CONTENTS_PER_BLOCK} folders; remove one first`, {
          code: 'BLOCK_CONTENT_LIMIT_REACHED', statusCode: 409,
        });
      }
      const created: MemoryBlockProjectContent = {
        directory: init.directory, content: init.content, rev: init.rev ?? readTombRev(paths.tomb) + 1,
        lastWriter: init.lastWriter, updatedAt: init.updatedAt ?? now().toISOString(),
      };
      writeAtomic(paths.file, created);
      fs.rmSync(paths.tomb, { force: true });
      return created;
    },

    /**
     * Rewrites the content of an existing file (404 when absent, 409 `PROFILE_STALE` when `expectedRev` is not its `rev`) and
     * bumps `rev`. `build` receives the current content and returns the new `content` and `lastWriter`.
     */
    updateContent(
      blockId: string, key: string, expectedRev: number,
      build: (current: MemoryBlockProjectContent) => { content: string; lastWriter: MemoryBlockWriter },
    ): MemoryBlockProjectContent {
      const paths = contentPathsOf(blockId, key);
      requireDefinition(blockId);
      const current = readContentFile(paths.file, paths.hash);
      if (!current) throw new AppError('No content for this folder', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
      if (current.rev !== expectedRev) {
        throw new AppError('This content was changed since you loaded it. Reload and try again.', {
          code: 'PROFILE_STALE', statusCode: 409, details: { currentRev: current.rev, currentUpdatedAt: current.updatedAt },
        });
      }
      const { content, lastWriter } = build(current);
      const next: MemoryBlockProjectContent = { directory: current.directory, content, lastWriter, rev: current.rev + 1, updatedAt: now().toISOString() };
      writeAtomic(paths.file, next);
      return next;
    },

    /**
     * Deletes the content file of a folder and leaves `<hash>.tomb` with its last `rev` (see `createContent`); true when a
     * file was removed. Works on an unreadable file too (its `rev` is then unknown and the tomb keeps the earlier one).
     */
    removeContent(blockId: string, key: string): boolean {
      const paths = contentPathsOf(blockId, key);
      requireDefinition(blockId);
      if (!fs.existsSync(paths.file)) return false;
      let lastRev = readTombRev(paths.tomb);
      try {
        lastRev = Math.max(lastRev, readContentFile(paths.file, paths.hash)?.rev ?? 0);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'PROFILE_CORRUPT') throw error;
      }
      writeAtomic(paths.tomb, { rev: lastRev });
      fs.rmSync(paths.file);
      return true;
    },

    /** Deletes every content file and tomb of a block (its folder under `memory-block-contents/`); idempotent. */
    removeAllContents(blockId: string): void {
      assertValidProfileId(blockId);
      const base = path.resolve(rootDir, CONTENTS_DIR);
      const target = path.resolve(base, blockId);
      if (path.dirname(target) !== base) {
        throw new AppError('Invalid profile id', { code: 'INVALID_PROFILE_ID', statusCode: 400 });
      }
      fs.rmSync(target, { recursive: true, force: true });
    },

    /** Copies a record file to `<rootDir>/<backupFolder>/<id>.json` unless the copy exists; true when it exists afterwards. */
    backupRecord(kind: AgentProfileKind, id: string, backupFolder: string): boolean {
      assertValidProfileId(id);
      const source = path.join(rootDir, kind, `${id}.json`);
      const target = path.join(rootDir, backupFolder, `${id}.json`);
      if (fs.existsSync(target)) return true;
      if (!fs.existsSync(source)) return false;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        fs.copyFileSync(source, temp);
        fs.renameSync(temp, target);
      } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      return true;
    },

    /** Module settings (defaults when no file yet); an unreadable file throws PROFILE_CORRUPT. */
    readSettings,

    /** Applies `patch` to the settings; with `expectedRev` set, a stale rev is refused (409). */
    updateSettings(
      patch: Partial<Pick<AgentProfileSettings, 'hiddenClaudeAgents'>>, expectedRev?: number,
    ): AgentProfileSettings {
      const current = readSettings();
      if (expectedRev !== undefined && current.rev !== expectedRev) {
        throw new AppError('Settings were changed since you loaded them. Reload and try again.', {
          code: 'PROFILE_STALE', statusCode: 409, details: { currentRev: current.rev },
        });
      }
      const rev = patch.hiddenClaudeAgents ? current.rev + 1 : current.rev;
      const next: AgentProfileSettings = { ...current, ...patch, rev, updatedAt: now().toISOString() };
      writeAtomic(settingsFile, next);
      return next;
    },

    /** Values remembered for a folder key (see {@link valuesKeyOf}); {} when none. */
    readRememberedValues(key: string): AgentProfileValues {
      return { ...(readValuesFile()[key] ?? {}) };
    },

    /**
     * Replaces the values remembered for a folder key; an empty map drops the key. Other folders are
     * kept as they are. Returns what is stored for the key afterwards.
     */
    writeRememberedValues(key: string, values: AgentProfileValues): AgentProfileValues {
      const all = readValuesFile();
      if (Object.keys(values).length === 0) delete all[key];
      else all[key] = { ...values };
      writeAtomic(valuesFile, all);
      return { ...values };
    },
  };
}

/** Store type the services depend on. Consumed by: agent-profiles.service.ts, claude-agents.service.ts, session scope. */
export type AgentProfileStore = ReturnType<typeof createAgentProfileStore>;
