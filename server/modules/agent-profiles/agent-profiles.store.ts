import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError, assertValidProfileId, isValidProfileId, normalizeProjectPath } from '@/shared/utils.js';
import type {
  AgentProfileKind,
  AgentProfileList,
  AgentProfileMeta,
  AgentProfileSettings,
  AgentProfileValues,
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
