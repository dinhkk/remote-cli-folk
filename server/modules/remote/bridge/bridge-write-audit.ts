/**
 * Which allowed requests the Host audits as writes (FR-42), and what a row says about them. A paired
 * Controller may change the Host through more than the file tree, so every allowed non-read request under
 * these families gets a row (route and outcome, plus a few short identifying fields):
 *
 * - `/api/file-tree/**` and `/api/assets/**` -> `file-write` (create, save, rename, delete, upload);
 * - `/api/git/**` (commit, checkout, push, ...), `POST /api/projects/clone` (it may SPEND a GitHub token stored
 *   on the Host: the row only says that one was used, never the token), `/api/providers/<p>/skills`
 *   (writes outside every project root) -> `host-write`.
 *
 * The identifying fields (the file path, a rename target, the project and branch, the repository URL, a skill
 * name) are read from the query and, for JSON requests, from the first 8 KiB of the body with a plain key
 * lookup: the body is never parsed as a whole, never copied beyond that window, and file contents, commit
 * messages, skill bodies and tokens are never looked at. The values are bounded here and masked and cut to
 * 200 characters by the audit service.
 */

import type { RemoteAuditEventKind } from '@/shared/types.js';

export type HostWriteArea = 'file-tree' | 'assets' | 'git' | 'clone' | 'skills';
export type HostWriteKind = { event: Extract<RemoteAuditEventKind, 'file-write' | 'host-write'>; area: HostWriteArea };

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Null for a read, or a write that is not in an audited family. */
export const classifyHostWrite = (method: string, canonicalPath: string): HostWriteKind | null => {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return null;
  const path = canonicalPath.toLowerCase();
  if (path.startsWith('/api/file-tree/')) return { event: 'file-write', area: 'file-tree' };
  if (path.startsWith('/api/assets/')) return { event: 'file-write', area: 'assets' };
  if (path.startsWith('/api/git/')) return { event: 'host-write', area: 'git' };
  if (path === '/api/projects/clone') return { event: 'host-write', area: 'clone' };
  if (/^\/api\/providers\/[^/]+\/skills(\/|$)/.test(path)) return { event: 'host-write', area: 'skills' };
  return null;
};

/** How much of a request body is looked at for the identifying fields. */
const BODY_WINDOW_BYTES = 8 * 1024;
/** Longest value handed on (the audit service cuts to 200 after masking). */
const FIELD_MAX = 1_000;

/** `[where it is in the request, name in the audit detail]`; the first one found for a detail name wins. */
const FIELDS: Record<HostWriteArea, ReadonlyArray<readonly [source: string, name: string]>> = {
  'file-tree': [['filePath', 'path'], ['path', 'path'], ['targetPath', 'path'], ['oldPath', 'path'], ['newName', 'to'], ['name', 'name']],
  assets: [],
  git: [['project', 'project'], ['branch', 'branch']],
  clone: [['path', 'path'], ['githubUrl', 'url']],
  skills: [['name', 'name']],
};

export type WriteProbe = {
  /** A chunk of the request body, as it goes to the Host (only the first 8 KiB is kept). */
  push(chunk: Uint8Array): void;
  /** The audit detail fields for the request whose raw target (path and query) is `rawTarget`. */
  details(rawTarget: string): Record<string, string | boolean>;
};

const stringField = (text: string, key: string): string | undefined => {
  const match = new RegExp(String.raw`"${key}"\s*:\s*"((?:\\.|[^"\\])*)"`).exec(text);
  if (!match) return undefined;
  try {
    return (JSON.parse(`"${match[1]}"`) as string).slice(0, FIELD_MAX);
  } catch {
    return undefined;
  }
};

const present = (text: string, key: string, shape: string): boolean => new RegExp(String.raw`"${key}"\s*:\s*${shape}`).test(text);

/**
 * Creates the probe of one request.
 * Consumed by: the HTTP half of the Host bridge.
 */
export function createWriteProbe(area: HostWriteArea, contentType: unknown): WriteProbe {
  const isJson = /json/i.test(String(contentType ?? ''));
  const head: Buffer[] = [];
  let kept = 0;

  return {
    push(chunk) {
      if (!isJson || kept >= BODY_WINDOW_BYTES) return;
      const part = Buffer.from(chunk.subarray(0, BODY_WINDOW_BYTES - kept));
      head.push(part);
      kept += part.length;
    },

    details(rawTarget) {
      const text = Buffer.concat(head).toString('utf8');
      const query = new URLSearchParams(rawTarget.includes('?') ? rawTarget.slice(rawTarget.indexOf('?') + 1, rawTarget.indexOf('?') + 1 + 2_000) : '');
      const detail: Record<string, string | boolean> = {};
      for (const [source, name] of FIELDS[area]) {
        if (detail[name] !== undefined) continue;
        const value = stringField(text, source) ?? query.get(source)?.slice(0, FIELD_MAX);
        if (value !== undefined && value !== '') detail[name] = value;
      }
      if (area === 'clone') {
        // Whether a stored GitHub token was spent, or a new one came with the request: never the token itself.
        if (present(text, 'githubTokenId', String.raw`\d`)) detail.githubTokenUsed = true;
        if (present(text, 'newGithubToken', '"[^"]')) detail.tokenSupplied = true;
      }
      return detail;
    },
  };
}
