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

/** Whether `directory` looks absolute on any OS (`/x`, `C:\x`, `C:/x`, `\\server`): relative paths would depend on this server's working directory. */
export const looksAbsolute = (directory: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(directory);

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
 * Why importing this template deserves its own tick: it grants powers the user should look at. `mcpServers` set, no
 * `tools` line (the agent inherits every tool), a tool that runs commands or writes (`Bash`, `Bash(...)`, `Write`,
 * `Edit`, `NotebookEdit`, any `mcp__*`), or non-empty `skills`. Empty list = safe.
 * Consumed by: agent-profiles.bundle.service.ts.
 */
export function templateSensitivity(input: AgentProfileTemplateInput): string[] {
  const reasons: string[] = [];
  if (input.mcpServers && input.mcpServers.length > 0) reasons.push('mcpServers');
  if (!input.tools || input.tools.length === 0) reasons.push('no-tools');
  for (const tool of input.tools ?? []) {
    if (/^(Bash|Write|Edit|NotebookEdit)(\(|$)/.test(tool) || tool.startsWith('mcp__')) reasons.push(`tool:${tool}`);
  }
  if (input.skills && input.skills.length > 0) reasons.push('skills');
  return [...new Set(reasons)];
}
