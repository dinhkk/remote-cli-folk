import { AppError } from '@/shared/utils.js';
import type {
  AgentProfileTemplateInput, ImportProblem, MemoryBlockInput, MemoryBlockWriter,
} from '@/shared/types.js';

import { MAX_FOLDER_ENTRIES_PER_BLOCK } from './agent-profiles.bundle.format.js';
import { HARD_MAX_BLOCK_CHARS, parseBlockInput } from './agent-profiles.blocks.validation.js';
import { blockContentKey } from './agent-profiles.store.js';
import { parseTemplateInput } from './agent-profiles.validation.js';

/** Longest folder path a bundle entry may carry. */
const MAX_DIRECTORY_CHARS = 4096;

/** Fields a bundle writer may use on a template; `id`, `rev` and the timestamps are tolerated and dropped. */
const TEMPLATE_FIELDS = new Set([
  'slug', 'family', 'name', 'description', 'instructions', 'params', 'bindings', 'tools', 'disallowedTools', 'mcpServers', 'skills',
  'model', 'memory', 'usesBlocks', 'group',
]);
const BLOCK_FIELDS = new Set(['name', 'description', 'mode', 'scope', 'maxChars', 'content', 'contents', 'lastWriter']);
/** Bookkeeping an export never writes and an import never trusts; silently dropped, not a warning. */
const DROPPED_FIELDS = new Set(['id', 'rev', 'updatedAt', 'createdAt', 'definitionRev', 'needsAttention', 'isDefaultOrchestrator', 'origin']);
const CONTENT_ENTRY_FIELDS = new Set(['directory', 'content', 'lastWriter']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One folder-text entry of a project block after validation; an entry with `problem` cannot be imported. */
export type ValidFolderEntry = {
  /** Position in `contents`, for messages and paths. */
  index: number;
  directory: string;
  /** The store's key of `directory` (computed on this host); the key of `projectMap`. */
  sourceKey: string;
  content: string;
  writer: Exclude<MemoryBlockWriter, null>;
  problem?: { code: string; message: string };
};

/** A block of a bundle after validation. `text` is set only when a global block carried `content`. */
export type ValidBlockEntry = {
  name: string;
  input: MemoryBlockInput;
  text: string | null;
  writer: Exclude<MemoryBlockWriter, null>;
  folders: ValidFolderEntry[];
};

/**
 * Provenance label an import keeps: `agent:<name>` text stays agent text; `user`, null and anything unrecognised become
 * `user` (the Host user chose to import it). Never lets a bundle claim a label it could not have.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function provenanceOf(value: unknown): Exclude<MemoryBlockWriter, null> {
  if (typeof value === 'string' && value.startsWith('agent:') && value.length > 'agent:'.length && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value)) {
    return value as `agent:${string}`;
  }
  return 'user';
}

/** Whether `directory` looks absolute (used inside this file only) on any OS (`/x`, `C:\x`, `C:/x`, `\\server`): relative paths would depend on this server's working directory. */
const looksAbsolute = (directory: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(directory);

function unknownFieldWarnings(source: Record<string, unknown>, known: Set<string>, base: string): ImportProblem[] {
  return Object.keys(source)
    .filter((key) => !known.has(key) && !DROPPED_FIELDS.has(key))
    .map((key) => ({ level: 'warning', code: 'unknown-field', message: `Unknown field "${key}" is ignored`, path: `${base}.${key}` }));
}

/** First word of a validator message names the field (`tools must be a list ...`): the path of the problem. */
function pathOfMessage(message: string, base: string, known: Set<string>): string {
  const first = message.split(/[\s:]/, 1)[0];
  return known.has(first) ? `${base}.${first}` : base;
}

/**
 * Validates one template of a bundle with the same parser the template form uses (so every rule stays in one place),
 * plus unknown-field warnings. Never throws: a bad item is returned as problems.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function validateTemplateEntry(raw: unknown, index: number): { slug: string | null; input: AgentProfileTemplateInput | null; problems: ImportProblem[] } {
  const base = `templates[${index}]`;
  if (!isRecord(raw)) {
    return { slug: null, input: null, problems: [{ level: 'error', code: 'INVALID_ITEM', message: 'A template must be a mapping of fields', path: base }] };
  }
  const slug = typeof raw.slug === 'string' && raw.slug ? raw.slug : null;
  const problems = unknownFieldWarnings(raw, TEMPLATE_FIELDS, base);
  try {
    return { slug, input: parseTemplateInput(raw), problems };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { slug, input: null, problems: [...problems, { level: 'error', code: error.code, message: error.message, path: pathOfMessage(error.message, base, TEMPLATE_FIELDS) }] };
  }
}

function validateFolderEntries(raw: unknown, base: string): { folders: ValidFolderEntry[]; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  if (!Array.isArray(raw)) {
    return { folders: [], problems: [{ level: 'error', code: 'INVALID_ITEM', message: 'contents must be a list', path: `${base}.contents` }] };
  }
  const folders: ValidFolderEntry[] = [];
  raw.forEach((entry, index) => {
    const path = `${base}.contents[${index}]`;
    const fail = (code: string, message: string, writer: ValidFolderEntry['writer'] = 'user'): void => {
      folders.push({ index, directory: '', sourceKey: '', content: '', writer, problem: { code, message: `${message} (at ${path})` } });
    };
    if (!isRecord(entry)) return fail('INVALID_ITEM', 'A folder entry must be a mapping with directory and content');
    problems.push(...unknownFieldWarnings(entry, CONTENT_ENTRY_FIELDS, path));
    const { directory, content } = entry;
    if (typeof directory !== 'string' || !directory.trim() || directory.length > MAX_DIRECTORY_CHARS || directory.includes('\0')) {
      return fail('INVALID_DIRECTORY', `directory must be text of 1-${MAX_DIRECTORY_CHARS} characters without NUL`);
    }
    if (!looksAbsolute(directory.trim())) return fail('INVALID_DIRECTORY', 'directory must be an absolute path (it is only used to match a folder; you choose the real project when importing)');
    if (typeof content !== 'string' || content.length > HARD_MAX_BLOCK_CHARS) {
      return fail('INVALID_ITEM', `content must be text of at most ${HARD_MAX_BLOCK_CHARS} characters`);
    }
    folders.push({ index, directory: directory.trim(), sourceKey: blockContentKey(directory.trim()), content, writer: provenanceOf(entry.lastWriter) });
  });
  return { folders, problems };
}

/**
 * Validates one memory block of a bundle: the definition with the same parser the block form uses, `scope.directory`
 * ignored (a folder never comes from a bundle definition), and the folder-text entries of a project block. A global block
 * without `content` is valid and carries no text (importing it never changes stored text). Never throws.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function validateBlockEntry(raw: unknown, index: number): { name: string | null; entry: ValidBlockEntry | null; problems: ImportProblem[] } {
  const base = `memoryBlocks[${index}]`;
  if (!isRecord(raw)) {
    return { name: null, entry: null, problems: [{ level: 'error', code: 'INVALID_ITEM', message: 'A memory block must be a mapping of fields', path: base }] };
  }
  const name = typeof raw.name === 'string' && raw.name ? raw.name : null;
  const problems = unknownFieldWarnings(raw, BLOCK_FIELDS, base);
  const scope = isRecord(raw.scope) ? raw.scope : null;
  if (scope && scope.directory !== undefined) {
    problems.push({ level: 'warning', code: 'ignored-field', message: 'scope.directory is ignored: folders are chosen by you when importing', path: `${base}.scope.directory` });
  }
  const kind = scope?.kind;
  const global = kind === 'global';
  if (raw.content !== undefined && raw.content !== null && typeof raw.content !== 'string') {
    return { name, entry: null, problems: [...problems, { level: 'error', code: 'INVALID_PROFILE_INPUT', message: 'content must be text', path: `${base}.content` }] };
  }
  const text = global && typeof raw.content === 'string' ? raw.content : null;
  if (!global && typeof raw.content === 'string' && kind === 'project') {
    problems.push({ level: 'warning', code: 'ignored-field', message: 'A project block keeps its text per folder: content is ignored (use contents)', path: `${base}.content` });
  }
  if (global && raw.contents !== undefined && raw.contents !== null) {
    problems.push({ level: 'warning', code: 'ignored-field', message: 'A global block has one text: contents is ignored (use content)', path: `${base}.contents` });
  }
  let input: MemoryBlockInput;
  try {
    // Only known fields reach the parser, and never a folder in the scope.
    input = parseBlockInput({
      name: raw.name, description: raw.description, mode: raw.mode, maxChars: raw.maxChars,
      scope: scope ? { kind: scope.kind } : raw.scope, content: global ? text ?? '' : undefined,
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const path = error.message.startsWith('scope') ? `${base}.scope` : pathOfMessage(error.message, base, BLOCK_FIELDS);
    return { name, entry: null, problems: [...problems, { level: 'error', code: error.code, message: error.message, path }] };
  }
  let folders: ValidFolderEntry[] = [];
  if (input.scope.kind === 'project' && raw.contents !== undefined && raw.contents !== null) {
    const parsed = validateFolderEntries(raw.contents, base);
    problems.push(...parsed.problems);
    folders = parsed.folders;
    if (parsed.problems.some((problem) => problem.level === 'error')) return { name, entry: null, problems };
    if (folders.length > MAX_FOLDER_ENTRIES_PER_BLOCK) {
      return { name, entry: null, problems: [...problems, { level: 'error', code: 'BLOCK_CONTENT_LIMIT_REACHED', message: `A block can have text for at most ${MAX_FOLDER_ENTRIES_PER_BLOCK} folders (this one lists ${folders.length})`, path: `${base}.contents` }] };
    }
  }
  return { name, entry: { name: input.name, input, text, writer: provenanceOf(raw.lastWriter), folders }, problems };
}

/**
 * The tool names a `tools` list really names: the generated agent file joins the entries with commas into one line that
 * Claude Code splits again, so an entry such as "Read, Bash" grants two tools. Splits on commas outside parentheses
 * (a `Bash(git log, x)` rule stays whole) and drops empty parts.
 * Consumed by: this file (sensitivity), agent-profiles.changeset.ts (guardrails).
 */
export function toolNamesOf(tools: readonly string[]): string[] {
  const names: string[] = [];
  for (const entry of tools) {
    let depth = 0;
    let current = '';
    for (const char of entry) {
      if (char === '(') depth += 1;
      if (char === ')') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) { names.push(current); current = ''; } else current += char;
    }
    names.push(current);
  }
  return names.map((name) => name.trim()).filter(Boolean);
}

/**
 * Why importing this template deserves its own tick: it grants powers the user should look at. `mcpServers` set, no
 * `tools` line (the agent inherits every tool), a tool that runs commands or writes (`Bash`, `Bash(...)`, `Write`,
 * `Edit`, `NotebookEdit`, any `mcp__*`), or non-empty `skills`. Empty list = safe.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function templateSensitivity(input: AgentProfileTemplateInput): string[] {
  const reasons: string[] = [];
  if (input.mcpServers && input.mcpServers.length > 0) reasons.push('mcpServers');
  if (!input.tools || input.tools.length === 0) reasons.push('no-tools');
  for (const tool of toolNamesOf(input.tools ?? [])) {
    if (/^(Bash|Write|Edit|NotebookEdit)\s*(\(|$)/i.test(tool.trim()) || tool.trim().toLowerCase().startsWith('mcp__')) reasons.push(`tool:${tool}`);
  }
  if (input.skills && input.skills.length > 0) reasons.push('skills');
  return [...new Set(reasons)];
}

// ---------- request bodies of the bundle routes ----------

const MAX_LIST_ITEMS = 2000;
const MAX_KEY_CHARS = 5000;

const invalidRequest = (message: string): AppError => new AppError(message, { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });

function optionalIdList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || value.some((id) => typeof id !== 'string' || !id || id.length > 200)) {
    throw invalidRequest(`${field} must be a list of ids`);
  }
  return value as string[];
}

function keyList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || value.some((key) => typeof key !== 'string' || key.length > MAX_KEY_CHARS)) {
    throw invalidRequest(`${field} must be a list of keys`);
  }
  return value as string[];
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_LIST_ITEMS) throw invalidRequest(`${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => key.length > MAX_KEY_CHARS || typeof item !== 'string' || item.length > 200)) throw invalidRequest(`${field} must map text to text`);
  return Object.fromEntries(entries) as Record<string, string>;
}

/** What the export route carries: optional id lists (omitted = all), whether block text is included, and the file format. */
export function parseExportRequest(body: unknown): { templateIds?: string[]; blockIds?: string[]; includeBlockContent: boolean; format: 'yaml' | 'json' } {
  const source = body === undefined || body === null ? {} : body;
  if (!isRecord(source)) throw invalidRequest('request body must be an object');
  if (source.includeBlockContent !== undefined && typeof source.includeBlockContent !== 'boolean') throw invalidRequest('includeBlockContent must be true or false');
  if (source.format !== undefined && source.format !== 'yaml' && source.format !== 'json') throw invalidRequest('format must be "yaml" or "json"');
  return {
    templateIds: optionalIdList(source.templateIds, 'templateIds'),
    blockIds: optionalIdList(source.blockIds, 'blockIds'),
    includeBlockContent: source.includeBlockContent === true,
    format: source.format === 'json' ? 'json' : 'yaml',
  };
}

/** The ticks and the revisions a preview showed, as every apply request carries them. */
type ParsedChoices = { overwrite: string[]; acceptSensitive: string[]; basis: Record<string, number | 'absent'> };

function parseChoices(source: Record<string, unknown>): ParsedChoices {
  const basis: Record<string, number | 'absent'> = {};
  if (source.basis !== undefined && source.basis !== null) {
    if (!isRecord(source.basis) || Object.keys(source.basis).length > MAX_LIST_ITEMS) throw invalidRequest('basis must be an object');
    for (const [key, value] of Object.entries(source.basis)) {
      if (key.length > MAX_KEY_CHARS || !(value === 'absent' || (Number.isInteger(value) && (value as number) >= 0))) throw invalidRequest('basis values must be a revision number or "absent"');
      basis[key] = value as number | 'absent';
    }
  }
  return { overwrite: keyList(source.overwrite, 'overwrite'), acceptSensitive: keyList(source.acceptSensitive, 'acceptSensitive'), basis };
}

/**
 * What the import preview and import routes carry: the bundle `text` (YAML or JSON, parsed by the server) and the user's
 * choices. `projectMap` maps a source folder key to a sidebar project id; `basis` is what the preview saw per ticked key.
 */
export function parseImportRequest(body: unknown): ParsedChoices & { text: string; projectMap: Record<string, string> } {
  const source = isRecord(body) ? body : null;
  if (!source) throw invalidRequest('request body must be an object');
  if (typeof source.text !== 'string' || !source.text.trim()) throw invalidRequest('text is required (the bundle as YAML or JSON)');
  return { text: source.text, projectMap: stringMap(source.projectMap, 'projectMap'), ...parseChoices(source) };
}

/**
 * The confirm route of a pending proposal: the ticks (`overwrite` also carries the keys of ticked deletes), the sensitive
 * ticks and the `basis` the pending list showed. All optional (an empty body confirms only what needs no tick).
 * Consumed by: agent-profiles.routes.ts.
 */
export function parseConfirmRequest(body: unknown): ParsedChoices {
  const source = body === undefined || body === null ? {} : body;
  if (!isRecord(source)) throw invalidRequest('request body must be an object');
  return parseChoices(source);
}

/** The restore route's body: the snapshot's file name (checked against the snapshot name pattern by the snapshot store). */
export function parseRestoreRequest(body: unknown): { snapshot: string } {
  const snapshot = isRecord(body) ? body.snapshot : undefined;
  if (typeof snapshot !== 'string' || !snapshot || snapshot.length > 200) throw invalidRequest('snapshot is required (a snapshot file name)');
  return { snapshot };
}
