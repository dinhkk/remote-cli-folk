import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';
import type { AgentBundle, AgentBundleSnapshot } from '@/shared/types.js';

import { serializeBundle } from './agent-profiles.bundle.format.js';

/** `<UTC yyyymmddThhmmssmmmZ>-<4 hex>.json`: the only file names listed, read or restored (no `:`, safe on Windows). */
const SNAPSHOT_NAME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{4}\.json$/;
/** Snapshots are pruned only when they are both older than this and beyond the newest {@link KEEP_NEWEST}. */
const KEEP_DAYS = 14;
const KEEP_NEWEST = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Errors of `link` on a file system that cannot hard link (FAT, some network and container mounts). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EACCES']);

const unavailable = (reason: string): AppError => new AppError(
  `No backup could be written (${reason}); nothing was changed. Free disk space or fix the folder permissions and try again.`,
  { code: 'SNAPSHOT_UNAVAILABLE', statusCode: 409 },
);

const notFound = (): AppError => new AppError('Snapshot not found', { code: 'SNAPSHOT_NOT_FOUND', statusCode: 404 });

/** Time encoded in a snapshot name, or null when the name is not a snapshot name. */
function createdAtOf(name: string): Date | null {
  const match = SNAPSHOT_NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`);
}

const stamp = (date: Date): string => date.toISOString().replace(/[-:.]/g, '');

/**
 * Server-written snapshots of the templates and memory blocks, taken before an import overwrites anything. Files are JSON
 * bundles in `directory` (mode 0700, files 0600), created exclusively so a name never collides. Only names that match the
 * snapshot pattern are ever read: a client names a snapshot, never a path.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function createSnapshotStore(options: { directory: string; now?: () => Date }) {
  const { directory } = options;
  const now = options.now ?? (() => new Date());

  function ensureDirectory(): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort (Windows) */ }
  }

  /** Newest first; names only. */
  function names(): string[] {
    try {
      return fs.readdirSync(directory).filter((entry) => SNAPSHOT_NAME_PATTERN.test(entry)).sort().reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  function prune(): void {
    const cutoff = now().getTime() - KEEP_DAYS * DAY_MS;
    names().slice(KEEP_NEWEST).forEach((name) => {
      const createdAt = createdAtOf(name);
      if (createdAt && createdAt.getTime() < cutoff) fs.rmSync(path.join(directory, name), { force: true });
    });
  }

  /**
   * Gives the finished temp file its final name without ever replacing a file: a hard link fails with EEXIST when the name
   * is taken. A file system without hard links falls back to an exclusive create (`wx`), which fails the same way.
   */
  function publish(temp: string, target: string, data: string): void {
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || !code || !LINK_UNSUPPORTED.has(code)) throw error;
      fs.writeFileSync(target, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
  }

  return {
    /** Writes `bundle` as a new snapshot and returns its file name; `SNAPSHOT_UNAVAILABLE` (409) when it cannot be written. */
    write(bundle: AgentBundle): string {
      const data = serializeBundle(bundle, 'json');
      try {
        ensureDirectory();
        const temp = path.join(directory, `.tmp-${randomBytes(6).toString('hex')}`);
        fs.writeFileSync(temp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const name = `${stamp(now())}-${randomBytes(2).toString('hex')}.json`;
            try {
              publish(temp, path.join(directory, name), data);
              try { prune(); } catch (error) { console.warn('[agent-profiles] old snapshots could not be pruned:', error); }
              return name;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
          }
          throw new Error('could not find a free snapshot name');
        } finally {
          fs.rmSync(temp, { force: true });
        }
      } catch (error) {
        throw unavailable(error instanceof Error ? error.message : String(error));
      }
    },

    /** Snapshots newest first, with what each holds; a file that cannot be read is listed with zero counts. */
    list(): AgentBundleSnapshot[] {
      return names().map((name) => {
        const file = path.join(directory, name);
        let templates = 0;
        let blocks = 0;
        let folders = 0;
        let bytes = 0;
        try {
          const text = fs.readFileSync(file, 'utf8');
          bytes = Buffer.byteLength(text);
          const value = JSON.parse(text) as { templates?: unknown[]; memoryBlocks?: { contents?: unknown[] }[] };
          templates = value.templates?.length ?? 0;
          blocks = value.memoryBlocks?.length ?? 0;
          folders = (value.memoryBlocks ?? []).reduce((sum, block) => sum + (block.contents?.length ?? 0), 0);
        } catch { /* listed anyway */ }
        return { name, createdAt: (createdAtOf(name) as Date).toISOString(), templates, blocks, folders, bytes };
      });
    },

    /** Text of the snapshot called `name`; 404 `SNAPSHOT_NOT_FOUND` for a name that is not a snapshot file name or has no file. */
    read(name: string): string {
      if (typeof name !== 'string' || !SNAPSHOT_NAME_PATTERN.test(name)) throw notFound();
      try {
        return fs.readFileSync(path.join(directory, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
        throw error;
      }
    },
  };
}

/** Snapshot store type the bundle service depends on. Consumed by: agent-profiles.bundle.service.ts. */
export type SnapshotStore = ReturnType<typeof createSnapshotStore>;
