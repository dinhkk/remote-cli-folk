import { AppError } from '@/shared/utils.js';
import type {
  AgentChangeset, AgentProfileTemplate, AgentProfileTemplateInput, ChangesetDelete, ChangesetFieldChange, ChangesetReviewItem,
  ImportBasis, ImportPlanItem, ProfilesLiveBlock, ProfilesLiveView, RawAgentBundle,
} from '@/shared/types.js';

import { isValidBlockName } from './agent-profiles.blocks.validation.js';
import { BUNDLE_FORMAT, BUNDLE_VERSION } from './agent-profiles.bundle.format.js';
import { validateBlockEntry, validateTemplateEntry } from './agent-profiles.bundle.validation.js';
import { PROFILES_TOOL_REFERENCE } from './agent-profiles.profiles.tool-names.js';
import { SLUG_PATTERN } from './agent-profiles.validation.js';

/** A changeset names at most this many templates, blocks and deletes together. */
const MAX_CHANGESET_ITEMS = 5;
/** A changeset is at most this many bytes as JSON. */
const MAX_CHANGESET_BYTES = 20 * 1024;

/** Longest text of a changed field shown to the person who confirms (the rest is cut). */
const MAX_SHOWN_CHARS = 4000;
/** Longest list (tools, skills) shown in one summary line. */
const MAX_SHOWN_LIST_CHARS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (code: string, message: string): AppError => new AppError(message, { code, statusCode: 400 });

/**
 * JSON text with object keys sorted at every level, so two values that mean the same compare equal as text.
 * Consumed by: agent-profiles.bundle.service.ts (identical-or-conflict check), this file (changed fields).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  ));
}

// ---------- parsing ----------

/** Keys of the bundle items of `upsert`, as far as they can be told before validation (an item without a usable name has no key). */
function upsertKeys(upsert: RawAgentBundle | undefined): string[] {
  if (!upsert) return [];
  const keys: string[] = [];
  for (const entry of upsert.templates) if (isRecord(entry) && typeof entry.slug === 'string') keys.push(`template:${entry.slug}`);
  for (const entry of upsert.memoryBlocks) if (isRecord(entry) && typeof entry.name === 'string') keys.push(`block:${entry.name}`);
  return keys;
}

function parseUpsert(value: unknown): RawAgentBundle {
  if (!isRecord(value)) throw invalid('CHANGESET_INVALID', 'upsert must be a bundle: an object with templates and/or memoryBlocks lists');
  for (const key of Object.keys(value)) {
    if (!['format', 'version', 'exportedAt', 'templates', 'memoryBlocks'].includes(key)) throw invalid('CHANGESET_INVALID', `upsert has an unknown field "${key}"`);
  }
  // An agent may leave out the envelope; when it is given it must be this build's.
  if (value.format !== undefined && value.format !== BUNDLE_FORMAT) throw invalid('CHANGESET_INVALID', `upsert.format must be "${BUNDLE_FORMAT}" when given`);
  if (value.version !== undefined && value.version !== BUNDLE_VERSION) throw invalid('CHANGESET_INVALID', `upsert.version must be ${BUNDLE_VERSION} when given`);
  for (const key of ['templates', 'memoryBlocks'] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) throw invalid('CHANGESET_INVALID', `upsert.${key} must be a list`);
  }
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: '',
    templates: (value.templates as unknown[] | undefined) ?? [], memoryBlocks: (value.memoryBlocks as unknown[] | undefined) ?? [],
  };
}

function parseDeletes(value: unknown): ChangesetDelete[] {
  if (!Array.isArray(value)) throw invalid('CHANGESET_INVALID', 'delete must be a list of {kind, key}');
  return value.map((entry, index) => {
    if (!isRecord(entry) || (entry.kind !== 'template' && entry.kind !== 'block') || typeof entry.key !== 'string') {
      throw invalid('CHANGESET_INVALID', `delete[${index}] must be {kind: "template" | "block", key: <slug or block name>}`);
    }
    const valid = entry.kind === 'template' ? entry.key.length <= 40 && SLUG_PATTERN.test(entry.key) : isValidBlockName(entry.key);
    if (!valid) throw invalid('CHANGESET_INVALID', `delete[${index}].key is not a valid ${entry.kind === 'template' ? 'template slug' : 'block name'}`);
    return { kind: entry.kind, key: entry.key };
  });
}

/**
 * Reads what an agent sends to `profiles_preview` / `profiles_propose` (or a pending file): `{upsert?: bundle, delete?: [{kind, key}]}`.
 * Refuses unknown fields, more than {@link MAX_CHANGESET_ITEMS} items, more than {@link MAX_CHANGESET_BYTES} bytes, an empty
 * changeset and a key that is both upserted and deleted (or deleted twice). Items of `upsert` are NOT validated here (the bundle
 * plan does that per item). Returns a fresh object; the input is not kept. Errors are `CHANGESET_*` (400).
 * Consumed by: agent-profiles.pending.service.ts (propose, preview, read of a pending file).
 */
export function parseChangeset(raw: unknown): AgentChangeset {
  if (!isRecord(raw)) throw invalid('CHANGESET_INVALID', 'The changeset must be an object: {upsert?: bundle, delete?: [{kind, key}]}');
  for (const key of Object.keys(raw)) {
    if (key !== 'upsert' && key !== 'delete') throw invalid('CHANGESET_INVALID', `The changeset has an unknown field "${key}"; only upsert and delete are allowed`);
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    throw invalid('CHANGESET_INVALID', 'The changeset must be plain JSON data');
  }
  if (bytes > MAX_CHANGESET_BYTES) throw invalid('CHANGESET_TOO_LARGE', `The changeset is ${bytes} bytes; the limit is ${MAX_CHANGESET_BYTES}. Propose fewer or smaller items.`);
  const upsert = raw.upsert === undefined || raw.upsert === null ? undefined : parseUpsert(raw.upsert);
  const deletes = raw.delete === undefined || raw.delete === null ? undefined : parseDeletes(raw.delete);
  const count = (upsert?.templates.length ?? 0) + (upsert?.memoryBlocks.length ?? 0) + (deletes?.length ?? 0);
  if (count === 0) throw invalid('CHANGESET_EMPTY', 'The changeset has no items');
  if (count > MAX_CHANGESET_ITEMS) throw invalid('CHANGESET_TOO_MANY_ITEMS', `The changeset has ${count} items; the limit is ${MAX_CHANGESET_ITEMS}. Split it into several proposals.`);
  const seen = new Set(upsertKeys(upsert));
  for (const item of deletes ?? []) {
    const key = `${item.kind}:${item.key}`;
    if (seen.has(key)) throw invalid('CHANGESET_CONFLICT', `${key} is listed twice (or both upserted and deleted); one item per key`);
    seen.add(key);
  }
  return { ...(upsert ? { upsert } : {}), ...(deletes ? { delete: deletes } : {}) };
}

// ---------- review ----------

type Context = {
  live: ProfilesLiveView;
  /** Names allowed to use the `profiles` tools; their own templates are off limits. */
  managers: ReadonlySet<string>;
};

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}...[cut]` : text);

/** A field value as text for the summary: lists joined, objects as JSON, long text cut. */
function shown(value: unknown, limit = MAX_SHOWN_LIST_CHARS): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return clip(value, limit);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return clip(value.join(', '), limit);
  return clip(canonicalJson(value), limit);
}

const TEMPLATE_FIELDS = [
  'family', 'name', 'description', 'instructions', 'params', 'bindings', 'tools', 'disallowedTools', 'mcpServers', 'skills', 'model', 'memory', 'usesBlocks', 'group',
] as const;
/** Long free text: shown in full (up to a cap) in a change; the other fields are short. */
const LONG_TEXT_FIELDS = new Set(['instructions', 'description', 'content']);

/** Fields of `after` that differ from `before` (a stored record in the shape of an input), with both values as text. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): ChangesetFieldChange[] {
  const changes: ChangesetFieldChange[] = [];
  for (const field of fields) {
    if (canonicalJson(before[field] ?? null) === canonicalJson(after[field] ?? null)) continue;
    const limit = LONG_TEXT_FIELDS.has(field) ? MAX_SHOWN_CHARS : MAX_SHOWN_LIST_CHARS;
    changes.push({ field, before: shown(before[field], limit), after: shown(after[field], limit) });
  }
  return changes;
}

/** A stored template in the shape an input has (no id, revision or timestamp). */
function inputShapeOf(template: AgentProfileTemplate): Record<string, unknown> {
  const { id: _id, rev: _rev, updatedAt: _updatedAt, slug: _slug, ...rest } = template;
  return rest;
}

const refused = (item: Pick<ChangesetReviewItem, 'key' | 'kind' | 'label' | 'basis' | 'sensitive'>, code: string, message: string): ChangesetReviewItem => ({
  ...item, action: 'refused', needsTick: false, refusal: { code, message }, lines: [`Refused (${code}): ${message}`], changes: [],
});

/** The first error of a plan item that cannot be applied, as `{code, message}`. */
function planRefusal(plan: ImportPlanItem): { code: string; message: string } {
  const first = plan.problems.find((problem) => problem.level === 'error');
  return { code: plan.code ?? first?.code ?? 'INVALID_ITEM', message: first?.message ?? 'This item cannot be applied' };
}

const toolList = (tools: readonly string[] | undefined): string => (tools && tools.length > 0 ? clip(tools.join(', '), MAX_SHOWN_LIST_CHARS) : 'none');

function templateLines(input: AgentProfileTemplateInput, action: 'create' | 'overwrite', changes: ChangesetFieldChange[]): string[] {
  if (action === 'overwrite') {
    return [
      `Overwrites template "${input.name}" (${input.slug}). Changed: ${changes.map((change) => change.field).join(', ') || 'nothing visible'}.`,
      `Tools after the change: ${toolList(input.tools)}.`,
    ];
  }
  const lines = [`New template "${input.name}" (${input.family}, slug ${input.slug}).`, `Tools: ${toolList(input.tools)}.`, `Instructions: ${input.instructions.length} characters.`];
  if (input.skills && input.skills.length > 0) lines.push(`Skills: ${toolList(input.skills)}.`);
  if (input.model) lines.push(`Model: ${input.model}.`);
  return lines;
}

function reviewTemplateUpsert(raw: unknown, index: number, plan: ImportPlanItem, context: Context): ChangesetReviewItem {
  const base = { key: plan.key, kind: 'template' as const, label: plan.label, basis: plan.basis, sensitive: plan.sensitive };
  if (plan.status === 'invalid') return refused(base, planRefusal(plan).code, planRefusal(plan).message);
  const input = validateTemplateEntry(raw, index).input as AgentProfileTemplateInput;
  if (plan.status === 'identical') return { ...base, action: 'identical', needsTick: false, lines: ['Already exists with the same content; nothing to do.'], changes: [] };
  if (input.mcpServers && input.mcpServers.length > 0) return refused(base, 'TEMPLATE_MCP_SERVERS', 'A template an agent proposes cannot attach MCP servers (mcpServers).');
  if (!input.tools || input.tools.length === 0) {
    return refused(base, 'TEMPLATE_NO_TOOLS', 'A template an agent proposes must state its tools: without a tools line the agent would inherit every tool.');
  }
  if (input.tools.some((tool) => PROFILES_TOOL_REFERENCE.test(tool.trim()))) {
    return refused(base, 'TEMPLATE_PROFILES_TOOL', 'A template an agent proposes cannot grant the profiles tools (mcp__profiles__*).');
  }
  if (context.managers.has(input.slug)) {
    return refused(base, 'TEMPLATE_IS_MANAGER', `"${input.slug}" is an agent that manages profiles: its template can only be changed by the user.`);
  }
  if (plan.status === 'conflict' && !plan.overwritable) return refused(base, planRefusal(plan).code, planRefusal(plan).message);
  const action = plan.status === 'new' ? 'create' : 'overwrite';
  const live = context.live.templates.get(input.slug);
  const changes = action === 'overwrite' && live ? changedFields(inputShapeOf(live), input as unknown as Record<string, unknown>, TEMPLATE_FIELDS) : [];
  const lines = templateLines(input, action, changes);
  if (plan.sensitive.length > 0) lines.push(`Sensitive, needs its own tick: ${plan.sensitive.join(', ')}.`);
  return { ...base, action, needsTick: action === 'overwrite', lines, changes };
}

function reviewBlockUpsert(raw: unknown, index: number, plan: ImportPlanItem, context: Context): ChangesetReviewItem {
  const base = { key: plan.key, kind: 'block' as const, label: plan.label, basis: plan.basis, sensitive: plan.sensitive };
  const source = isRecord(raw) ? raw : {};
  const scope = isRecord(source.scope) ? source.scope : {};
  // Folder text and folders are the Host's: an agent proposes a definition (and a global block's text) only.
  const hasContents = source.contents !== undefined && source.contents !== null && !(Array.isArray(source.contents) && source.contents.length === 0);
  if (hasContents || scope.directory !== undefined) {
    return refused(base, 'BLOCK_FOLDER_HOST_ONLY', 'An agent cannot propose folder text (contents) or name a folder (scope.directory); the user adds folders in the Memory tab.');
  }
  if (plan.status === 'invalid') return refused(base, planRefusal(plan).code, planRefusal(plan).message);
  if (plan.status === 'identical') return { ...base, action: 'identical', needsTick: false, lines: ['Already exists with the same content; nothing to do.'], changes: [] };
  const entry = validateBlockEntry(raw, index).entry as NonNullable<ReturnType<typeof validateBlockEntry>['entry']>;
  const live = context.live.blocks.get(entry.name);
  if (plan.status === 'conflict' && live) {
    if (live.definition.scope.kind !== entry.input.scope.kind) {
      return refused(base, 'BLOCK_SCOPE_IMMUTABLE', `A block named "${entry.name}" already exists with the ${live.definition.scope.kind} scope; the scope cannot change. Pick another name.`);
    }
    if (live.ambiguous) return refused(base, 'BLOCK_NAME_AMBIGUOUS', `More than one block is named "${entry.name}"; the user must rename one first.`);
    if (live.definition.mode === 'read-only') return refused(base, 'BLOCK_READ_ONLY', `Block "${entry.name}" is read-only: only the user can change it.`);
    if (live.problem) return refused(base, live.problem.code, live.problem.message);
    if (!plan.overwritable) return refused(base, planRefusal(plan).code, planRefusal(plan).message);
  }
  const action = plan.status === 'new' ? 'create' : 'overwrite';
  const after: Record<string, unknown> = { description: entry.input.description, mode: entry.input.mode, maxChars: entry.input.maxChars, ...(entry.text !== null ? { content: entry.text } : {}) };
  const before: Record<string, unknown> = live ? { description: live.definition.description, mode: live.definition.mode, maxChars: live.definition.maxChars, content: live.definition.content } : {};
  const changes = action === 'overwrite' ? changedFields(before, after, ['description', 'mode', 'maxChars', ...(entry.text !== null ? ['content'] : [])]) : [];
  const scopeName = entry.input.scope.kind;
  const lines = action === 'create'
    ? [`New ${scopeName} block "${entry.name}" (${entry.input.mode}, up to ${entry.input.maxChars} characters).`]
    : [`Overwrites ${scopeName} block "${entry.name}". Changed: ${changes.map((change) => change.field).join(', ') || 'nothing visible'}.`];
  if (scopeName === 'global') lines.push(entry.text === null ? 'Text: not part of this proposal (the stored text stays).' : `Text: ${entry.text.length} characters.`);
  else if (action === 'create') lines.push('A definition only: add the folders that should have text in the Memory tab.');
  return { ...base, action, needsTick: action === 'overwrite', lines, changes };
}

/**
 * Revision a delete is compared against at confirm: a template's `rev`; a global block's definition `rev`; a project block's
 * definition `rev` plus the sum of its folder revisions, so a change to any folder text after the review makes the tick stale.
 * Consumed by: this file (review of a delete).
 */
function deleteBasisOf(target: AgentProfileTemplate | ProfilesLiveBlock): ImportBasis {
  return 'definition' in target ? target.definition.rev + target.folderRevSum : target.rev;
}

function reviewDelete(item: ChangesetDelete, context: Context): ChangesetReviewItem {
  const key = `${item.kind}:${item.key}`;
  const base = { key, kind: item.kind, label: item.key, sensitive: [] as string[] };
  if (item.kind === 'template') {
    const live = context.live.templates.get(item.key);
    if (!live) return refused({ ...base, basis: 'absent' }, 'CHANGESET_TARGET_NOT_FOUND', `There is no template with the slug "${item.key}".`);
    const named = { ...base, label: live.name, basis: deleteBasisOf(live) };
    if (context.managers.has(live.slug)) return refused(named, 'TEMPLATE_IS_MANAGER', `"${live.slug}" is an agent that manages profiles: its template can only be changed by the user.`);
    return {
      ...named, action: 'delete', needsTick: true, changes: [],
      lines: [`Deletes template "${live.name}" (${live.slug}). Agent files already generated from it are not removed.`],
    };
  }
  const live = context.live.blocks.get(item.key);
  if (!live) return refused({ ...base, basis: 'absent' }, 'CHANGESET_TARGET_NOT_FOUND', `There is no memory block named "${item.key}".`);
  const named = { ...base, basis: deleteBasisOf(live) };
  if (live.ambiguous) return refused(named, 'BLOCK_NAME_AMBIGUOUS', `More than one block is named "${item.key}"; the user must rename one first.`);
  if (live.definition.mode === 'read-only') return refused(named, 'BLOCK_READ_ONLY', `Block "${item.key}" is read-only: only the user can delete it.`);
  if (live.problem) return refused(named, live.problem.code, live.problem.message);
  const lines = live.definition.scope.kind === 'global'
    ? [`Deletes global block "${item.key}"; its text (${live.definition.content.length} characters) is removed from the store.`]
    : [`Deletes project block "${item.key}" and its text in ${live.folders} folder(s) (${live.folderChars} characters in total); the folder files are removed.`];
  lines.push('A backup is taken first and Restore puts it back.');
  return { ...named, action: 'delete', needsTick: true, lines, changes: [] };
}

/**
 * The guardrails and the readable summary of an agent changeset, against the live store: one item per template, block and
 * delete (in that order). Pure: the caller reads the store (`live`), the allowlist (`managers`) and the import plan of
 * `upsert` (`plan`, from the bundle service: same order as `upsert.templates` then `upsert.memoryBlocks`).
 * Hard refusals (the item gets `action: 'refused'`): MCP servers, no tools line, `mcp__profiles__*` tools, a template of a
 * profiles-managing agent, any folder text or folder on a block, a block of the other scope, a read-only block or one that
 * cannot be backed up, a delete of something that is not there. A template's slug is the key an item is matched by, so an
 * overwrite can never rename it (the generated agent file keeps its name).
 * Consumed by: agent-profiles.bundle.service.ts (review and apply of a changeset, which runs it again at confirm).
 */
export function evaluateChangeset(input: { changeset: AgentChangeset; live: ProfilesLiveView; managers: readonly string[]; plan: readonly ImportPlanItem[] }): ChangesetReviewItem[] {
  const context: Context = { live: input.live, managers: new Set(input.managers) };
  const { upsert } = input.changeset;
  const templates = upsert?.templates ?? [];
  const blocks = upsert?.memoryBlocks ?? [];
  const items: ChangesetReviewItem[] = [];
  templates.forEach((raw, index) => items.push(reviewTemplateUpsert(raw, index, input.plan[index], context)));
  blocks.forEach((raw, index) => items.push(reviewBlockUpsert(raw, index, input.plan[templates.length + index], context)));
  for (const item of input.changeset.delete ?? []) items.push(reviewDelete(item, context));
  return items;
}

/** One line per refused item, for the error an agent reads when a proposal is refused. Consumed by: agent-profiles.pending.service.ts. */
export function refusalText(items: readonly ChangesetReviewItem[]): string {
  return items.filter((item) => item.refusal).map((item) => `${item.key}: ${item.refusal?.code} - ${item.refusal?.message}`).join('\n');
}
