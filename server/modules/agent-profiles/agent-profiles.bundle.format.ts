import { LineCounter, isAlias, isNode, parseDocument, stringify, visit, type Document } from 'yaml';

import { AppError } from '@/shared/utils.js';
import type { AgentBundle, RawAgentBundle } from '@/shared/types.js';

/** Value of `format` in every bundle. Consumed by: agent-profiles.bundle.service.ts (export envelope). */
export const BUNDLE_FORMAT = 'remotecli.agent-bundle';
/** Newest (and only) bundle version this build reads and writes. Consumed by: agent-profiles.bundle.service.ts (export envelope). */
export const BUNDLE_VERSION = 1;
/** Deepest nesting a bundle may have (a valid bundle needs 5). */
const MAX_NESTING_DEPTH = 8;
/** Folder-text entries one bundle may carry in total (the importer writes them in one synchronous section). */
const MAX_FOLDER_ENTRIES_PER_BUNDLE = 500;
/** Folder-text entries one block may carry (the store's per-block file cap). Consumed by: agent-profiles.bundle.validation.ts. */
export const MAX_FOLDER_ENTRIES_PER_BLOCK = 200;

type Position = { line: number; column: number };

/** A parsed bundle plus a way to find where a path such as `templates[2].tools` sits in the source text. */
export type ParsedBundleText = {
  bundle: RawAgentBundle;
  /** Position of the value at `path` (closest existing ancestor when it is absent); null when nothing matches. */
  locate: (path: string) => Position | null;
};

/** A `BUNDLE_INVALID` (400) worded for the person or AI who has to fix the file; `line`, `column` and `path` travel in `details`. */
function bundleError(message: string, where: { path?: string } & Partial<Position> = {}): AppError {
  const position = where.line === undefined ? '' : `Line ${where.line}, column ${where.column ?? 1}: `;
  const path = where.path ? ` (at ${where.path})` : '';
  return new AppError(`${position}${message}${path}`, {
    code: 'BUNDLE_INVALID', statusCode: 400, details: { ...(where.path ? { path: where.path } : {}), ...(where.line === undefined ? {} : { line: where.line, column: where.column ?? 1 }) },
  });
}

/** `templates[2].tools` -> ['templates', 2, 'tools']. */
function segmentsOf(path: string): (string | number)[] {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]));
}

/** True when `value` nests deeper than `limit` levels; iterative so a hostile file cannot overflow the stack here. */
function nestsDeeperThan(value: unknown, limit: number): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (typeof node !== 'object' || node === null) continue;
    if (depth > limit) return true;
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

function positionOf(lineCounter: LineCounter, offset: number): Position {
  const { line, col } = lineCounter.linePos(offset);
  return { line, column: col };
}

/** Refuses anchors and aliases (they only exist to expand a small file into a huge one) with the position of the first. */
function refuseAnchorsAndAliases(document: Document.Parsed, lineCounter: LineCounter): void {
  visit(document, {
    Node(_key, node) {
      const aliasOrAnchor = (node as { anchor?: string }).anchor !== undefined || isAlias(node);
      if (!aliasOrAnchor) return undefined;
      const range = (node as { range?: [number, number, number] | null }).range;
      throw bundleError('YAML anchors and aliases (&name, *name) are not allowed in a bundle; write the value out in full', range ? positionOf(lineCounter, range[0]) : {});
    },
  });
}

function validateEnvelope(value: unknown, where: (path: string) => Position | null): RawAgentBundle {
  const fail = (message: string, path = ''): never => { throw bundleError(message, { path, ...(where(path) ?? {}) }); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('The bundle must be a mapping with format, version, templates and memoryBlocks');
  const record = value as Record<string, unknown>;
  if (record.format !== BUNDLE_FORMAT) fail(`format must be "${BUNDLE_FORMAT}"`, 'format');
  if (record.version !== BUNDLE_VERSION) {
    if (Number.isInteger(record.version)) {
      throw new AppError(`Bundle version ${String(record.version)} is not supported (this app reads version ${BUNDLE_VERSION})`, { code: 'BUNDLE_VERSION_UNSUPPORTED', statusCode: 400 });
    }
    fail(`version must be the number ${BUNDLE_VERSION}`, 'version');
  }
  if (record.exportedAt !== undefined && record.exportedAt !== null && typeof record.exportedAt !== 'string') fail('exportedAt must be text', 'exportedAt');
  for (const key of ['templates', 'memoryBlocks']) {
    if (record[key] !== undefined && record[key] !== null && !Array.isArray(record[key])) fail(`${key} must be a list`, key);
  }
  const memoryBlocks = (record.memoryBlocks as unknown[] | undefined | null) ?? [];
  let folderEntries = 0;
  for (const block of memoryBlocks) {
    const contents = typeof block === 'object' && block !== null ? (block as { contents?: unknown }).contents : undefined;
    if (Array.isArray(contents)) folderEntries += contents.length;
  }
  if (folderEntries > MAX_FOLDER_ENTRIES_PER_BUNDLE) {
    fail(`A bundle carries at most ${MAX_FOLDER_ENTRIES_PER_BUNDLE} folder-text entries in total (this one has ${folderEntries}); split it`, 'memoryBlocks');
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
    templates: (record.templates as unknown[] | undefined | null) ?? [],
    memoryBlocks,
  };
}

/**
 * Reads a bundle written as YAML or JSON (JSON is YAML) and checks its envelope: `format`, `version === 1`, list shapes,
 * nesting depth and the folder-entry total. Items are not validated here (the import plan does that per item). Uses the
 * YAML core schema with aliases and anchors refused and duplicate keys an error. Every failure is a `BUNDLE_INVALID`
 * (`BUNDLE_VERSION_UNSUPPORTED` for another version) that carries the line, column and path when known.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function parseBundleText(text: string): ParsedBundleText {
  const lineCounter = new LineCounter();
  let document: Document.Parsed;
  let value: unknown;
  try {
    document = parseDocument(text, { schema: 'core', uniqueKeys: true, lineCounter, prettyErrors: false });
    const [first] = document.errors;
    if (first) {
      const at = first.pos ? positionOf(lineCounter, first.pos[0]) : {};
      throw bundleError(`Not valid YAML or JSON: ${first.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')}`, at);
    }
    if (document.contents === null || document.contents === undefined) throw bundleError('The bundle is empty');
    refuseAnchorsAndAliases(document, lineCounter);
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof RangeError) throw bundleError('The bundle is nested too deeply');
    throw bundleError(`Not valid YAML or JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (nestsDeeperThan(value, MAX_NESTING_DEPTH)) throw bundleError(`The bundle is nested deeper than ${MAX_NESTING_DEPTH} levels`);

  const locate = (path: string): Position | null => {
    const segments = segmentsOf(path);
    for (let length = segments.length; length >= 0; length -= 1) {
      const node = length === 0 ? document.contents : document.getIn(segments.slice(0, length), true);
      const range = isNode(node) ? node.range : null;
      if (range) return positionOf(lineCounter, range[0]);
    }
    return null;
  };
  return { bundle: validateEnvelope(value, locate), locate };
}

/**
 * Text of a bundle: YAML by default (multi-line prompts and block text as readable `|` block scalars) or JSON; the key
 * order is the order of the object (format, version, exportedAt, templates, memoryBlocks). Snapshots use JSON (exact).
 * Consumed by: agent-profiles.bundle.service.ts, agent-profiles.backup.ts.
 */
export function serializeBundle(bundle: AgentBundle, format: 'yaml' | 'json' = 'yaml'): string {
  const ordered = {
    format: bundle.format, version: bundle.version, exportedAt: bundle.exportedAt, templates: bundle.templates, memoryBlocks: bundle.memoryBlocks,
  };
  if (format === 'json') return `${JSON.stringify(ordered, null, 2)}\n`;
  return stringify(ordered, { schema: 'core', blockQuote: 'literal', lineWidth: 0, indent: 2 });
}
