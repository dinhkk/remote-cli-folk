import { AppError } from '@/shared/utils.js';
import type {
  AgentBundle, AgentBundleSnapshot, AgentProfileTemplate, AgentProfileTemplateInput, ExportProblem, ImportActor, ImportBasis, ImportFolderResult,
  ImportFolderRow, ImportItemResult, ImportOptions, ImportPlan, ImportPlanItem, ImportProblem, ImportResult, MemoryBlockBundleEntry,
  MemoryBlockDefinition, MemoryBlockProjectContent, MemoryBlockWriter, RawAgentBundle,
} from '@/shared/types.js';

import type { SnapshotStore } from './agent-profiles.backup.js';
import { BUNDLE_FORMAT, BUNDLE_VERSION, parseBundleText, serializeBundle, type ParsedBundleText } from './agent-profiles.bundle.format.js';
import {
  provenanceOf, templateSensitivity, validateBlockEntry, validateTemplateEntry, type ValidBlockEntry, type ValidFolderEntry,
} from './agent-profiles.bundle.validation.js';
import { MAX_MEMORY_BLOCKS } from './agent-profiles.blocks.validation.js';
import type { BlocksService } from './agent-profiles.blocks.service.js';
import type { AgentProfilesService } from './agent-profiles.service.js';
import { MAX_CONTENTS_PER_BLOCK, blockContentKey, blockFolderOf, type AgentProfileStore } from './agent-profiles.store.js';
import { parseTemplateInput } from './agent-profiles.validation.js';

type Dependencies = {
  profiles: AgentProfilesService;
  blocks: BlocksService;
  /** For the corrupt-record check only: the services discard what the store reports as unreadable. */
  store: AgentProfileStore;
  snapshots: SnapshotStore;
  /** Folder of a sidebar project by id (synchronous, like the app database call behind it); null when unknown. */
  resolveProjectDirectory: (projectId: string) => string | null;
  now?: () => Date;
};

const TEMPLATE_ORDER = [
  'slug', 'family', 'name', 'description', 'instructions', 'params', 'bindings', 'tools', 'disallowedTools', 'mcpServers', 'skills',
  'model', 'memory', 'usesBlocks', 'group',
] as const;

/** A block the store holds, with what the importer needs to know about it. */
type LiveBlock = {
  definition: MemoryBlockDefinition;
  /** Another block uses the same name (allowed only for blocks saved by an older version). */
  ambiguous: boolean;
  /** Why the block cannot be backed up (so cannot be overwritten or deleted), null when it can. */
  problem: { code: string; message: string } | null;
  contents: Map<string, MemoryBlockProjectContent>;
  /** Unreadable content files (they still count towards the 200-file cap). */
  corruptFiles: number;
};

type LiveState = {
  templates: Map<string, AgentProfileTemplate>;
  /** First block of each name. */
  blocks: Map<string, LiveBlock>;
  /** Every block, by name, for export. */
  allBlocks: LiveBlock[];
  corruptRecords: number;
};

type PlannedFolder = ImportFolderRow & { entry?: ValidFolderEntry; targetDirectory?: string };
type PlannedItem = Omit<ImportPlanItem, 'folders'> & {
  template?: AgentProfileTemplateInput;
  liveTemplate?: AgentProfileTemplate;
  block?: ValidBlockEntry;
  liveBlock?: LiveBlock;
  folders?: PlannedFolder[];
};

/** `upload`: a client's bundle (folders only through `projectMap`). `restore`: a snapshot this server wrote (everything overwritable, stored folders). */
type ImportMode = 'upload' | 'restore';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item
));

/** A stored template in the shape an import is compared in (no bookkeeping, normalised like an input). */
function normalizedTemplate(template: AgentProfileTemplate): unknown {
  const { id: _id, rev: _rev, updatedAt: _updatedAt, ...rest } = template;
  try {
    return parseTemplateInput(rest);
  } catch {
    return rest;
  }
}

const isStaleError = (error: unknown): boolean => error instanceof AppError && error.code === 'PROFILE_STALE';

/** The code and text an item or folder result carries for a failed write; unexpected errors never leak their message. */
function describeFailure(error: unknown, folder = false): { code: string; reason: string } {
  if (isStaleError(error) || (folder && error instanceof AppError && error.code === 'BLOCK_CONTENT_EXISTS')) {
    return { code: 'STALE', reason: 'Changed since the preview. Preview again before applying.' };
  }
  if (error instanceof AppError) return { code: error.code, reason: error.message };
  console.warn('[agent-profiles] bundle import failed unexpectedly:', error);
  return { code: 'INTERNAL_ERROR', reason: 'Unexpected error while writing this item' };
}

const errorsOf = (problems: ImportProblem[]): ImportProblem[] => problems.filter((problem) => problem.level === 'error');

/** An agent importing is recorded as the writer of what it writes; the user keeps the provenance the bundle carried. */
const writerFor = (actor: ImportActor, provenance: Exclude<MemoryBlockWriter, null>): Exclude<MemoryBlockWriter, null> =>
  actor.kind === 'agent' ? `agent:${actor.name}` : provenance;

/**
 * Export, dry-run and apply of agent bundles (templates + memory blocks), and restore of server-written snapshots.
 * Every rule (slug and name checks, 50-block cap, 200 files per block, `maxChars`, revisions, scope immutability) stays in
 * the template and block services; this service only decides what an import would do and calls them. Fully synchronous on
 * purpose: the snapshot, the re-plan and the writes run without another request interleaving. A bundle is untrusted input
 * (a person or an AI may have written it): nothing is written without an explicit tick, folders come only from the
 * sidebar project the user maps, and a snapshot is taken before any overwrite.
 * Consumed by: agent-profiles.routes.ts (via agent-profiles.module.ts).
 */
export function createBundleService(dependencies: Dependencies) {
  const {
    profiles, blocks, store, snapshots,
  } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  // ---------- reading the store ----------

  /** Templates and blocks as stored, with what each block's folder text looks like. Runs the legacy block migration once (through the blocks service). */
  function readLive(): LiveState {
    const listedTemplates = profiles.listTemplates();
    const definitions = blocks.list().blocks;
    const counts = new Map<string, number>();
    for (const definition of definitions) counts.set(definition.name, (counts.get(definition.name) ?? 0) + 1);
    const state: LiveState = {
      templates: new Map(listedTemplates.items.map((template) => [template.slug, template])),
      blocks: new Map(),
      allBlocks: [],
      corruptRecords: listedTemplates.corrupt.length + store.list('memory-blocks').corrupt.length,
    };
    for (const definition of definitions) {
      const live: LiveBlock = {
        definition, ambiguous: (counts.get(definition.name) ?? 0) > 1, problem: null, contents: new Map(), corruptFiles: 0,
      };
      if (definition.scope.kind === 'project') {
        if (definition.needsAttention) {
          live.problem = { code: 'BLOCK_NOT_MIGRATED', message: definition.needsAttention };
        } else {
          try {
            const { contents, corrupt } = blocks.listContents(definition.id);
            for (const content of contents) live.contents.set(blockContentKey(content.directory), content);
            live.corruptFiles = corrupt.length;
            if (corrupt.length > 0) live.problem = { code: 'BLOCK_CONTENT_CORRUPT', message: `${corrupt.length} folder text file(s) of this block are unreadable, so it cannot be backed up` };
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'BLOCK_NOT_MIGRATED') throw error;
            live.problem = { code: 'BLOCK_NOT_MIGRATED', message: error.message };
          }
        }
      }
      state.allBlocks.push(live);
      if (!state.blocks.has(definition.name)) state.blocks.set(definition.name, live);
    }
    return state;
  }

  // ---------- export ----------

  function templateEntry(template: AgentProfileTemplate): AgentProfileTemplateInput {
    const source = template as unknown as Record<string, unknown>;
    const entry: Record<string, unknown> = {};
    for (const key of TEMPLATE_ORDER) if (source[key] !== undefined) entry[key] = source[key];
    return entry as AgentProfileTemplateInput;
  }

  function blockEntry(live: LiveBlock, includeText: boolean, problems: ExportProblem[]): MemoryBlockBundleEntry {
    const { definition } = live;
    const entry: MemoryBlockBundleEntry = {
      name: definition.name, description: definition.description, mode: definition.mode, scope: { kind: definition.scope.kind }, maxChars: definition.maxChars,
    };
    if (live.problem) problems.push({ key: `block:${definition.name}`, code: live.problem.code, message: live.problem.message });
    if (!includeText) return entry;
    if (definition.scope.kind === 'global') {
      entry.content = definition.content;
      if (definition.lastWriter) entry.lastWriter = definition.lastWriter;
    } else if (live.problem?.code !== 'BLOCK_NOT_MIGRATED') {
      // A block that was not moved keeps its text in the old record: it is never exported as folder or global text.
      entry.contents = [...live.contents.values()]
        .sort((a, b) => a.directory.localeCompare(b.directory))
        .map((content) => ({ directory: content.directory, content: content.content, ...(content.lastWriter ? { lastWriter: content.lastWriter } : {}) }));
    }
    return entry;
  }

  /**
   * The bundle for the chosen templates and blocks (omitted ids = all). Block text (a global block's text and every folder
   * text of a project block, with its stored folder) is included only when `includeBlockContent` is set. A block that
   * cannot be exported completely (not yet moved to per-folder content, unreadable folder file) is exported as far as
   * possible and listed in `problems`.
   */
  function exportFrom(live: LiveState, options: { templateIds?: string[]; blockIds?: string[]; includeBlockContent?: boolean }): { bundle: AgentBundle; problems: ExportProblem[] } {
    const problems: ExportProblem[] = [];
    const templateIds = options.templateIds ? new Set(options.templateIds) : null;
    const blockIds = options.blockIds ? new Set(options.blockIds) : null;
    const templates = [...live.templates.values()]
      .filter((template) => !templateIds || templateIds.has(template.id))
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(templateEntry);
    const memoryBlocks = live.allBlocks
      .filter((block) => !blockIds || blockIds.has(block.definition.id))
      .map((block) => blockEntry(block, options.includeBlockContent === true, problems));
    return {
      bundle: { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now().toISOString(), templates, memoryBlocks },
      problems,
    };
  }

  const exportBundle = (options: { templateIds?: string[]; blockIds?: string[]; includeBlockContent?: boolean } = {}): { bundle: AgentBundle; problems: ExportProblem[] } =>
    exportFrom(readLive(), options);

  // ---------- plan ----------

  const cleanProjectMap = (map: unknown): Map<string, string> => {
    const result = new Map<string, string>();
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return result;
    for (const [key, value] of Object.entries(map)) if (typeof value === 'string' && value) result.set(key, value);
    return result;
  };

  function planTemplates(raw: RawAgentBundle, live: LiveState): PlannedItem[] {
    const validated = raw.templates.map((entry, index) => validateTemplateEntry(entry, index));
    const slugCounts = new Map<string, number>();
    for (const result of validated) if (result.slug) slugCounts.set(result.slug, (slugCounts.get(result.slug) ?? 0) + 1);
    return validated.map((result, index): PlannedItem => {
      const key = `template:${result.slug ?? `#${index}`}`;
      const base = { key, kind: 'template' as const, label: result.input?.name || result.slug || `Template ${index + 1}`, sensitive: [] as string[], basis: 'absent' as ImportBasis };
      if (!result.input) {
        const [first] = errorsOf(result.problems);
        return { ...base, status: 'invalid', code: first?.code, overwritable: false, problems: result.problems };
      }
      if ((slugCounts.get(result.input.slug) ?? 0) > 1) {
        const problems = [...result.problems, { level: 'error' as const, code: 'DUPLICATE_KEY', message: `The slug "${result.input.slug}" appears more than once in this bundle`, path: `templates[${index}].slug` }];
        return { ...base, status: 'invalid', code: 'DUPLICATE_KEY', overwritable: false, problems };
      }
      const item: PlannedItem = { ...base, status: 'new', overwritable: false, problems: result.problems, sensitive: templateSensitivity(result.input), template: result.input };
      const existing = live.templates.get(result.input.slug);
      if (!existing) return item;
      item.liveTemplate = existing;
      item.basis = existing.rev;
      item.status = canonical(normalizedTemplate(existing)) === canonical(result.input) ? 'identical' : 'conflict';
      item.overwritable = item.status === 'conflict';
      return item;
    });
  }

  function definitionStatus(entry: ValidBlockEntry, live: LiveBlock): { status: PlannedItem['status']; code?: string; overwritable: boolean } {
    if (live.ambiguous) return { status: 'conflict', code: 'BLOCK_NAME_AMBIGUOUS', overwritable: false };
    if (live.definition.scope.kind !== entry.input.scope.kind) return { status: 'conflict', code: 'BLOCK_SCOPE_IMMUTABLE', overwritable: false };
    const { definition } = live;
    const same = definition.description === entry.input.description && definition.mode === entry.input.mode && definition.maxChars === entry.input.maxChars
      && (entry.text === null || definition.content === entry.text);
    if (same) return { status: 'identical', overwritable: false };
    if (live.problem) return { status: 'conflict', code: live.problem.code, overwritable: false };
    return { status: 'conflict', overwritable: true };
  }

  function planFolders(
    name: string, entry: ValidBlockEntry, live: LiveBlock | undefined, context: { projectMap: Map<string, string>; mode: ImportMode },
  ): PlannedFolder[] {
    const keyCounts = new Map<string, number>();
    for (const folder of entry.folders) if (!folder.problem) keyCounts.set(folder.sourceKey, (keyCounts.get(folder.sourceKey) ?? 0) + 1);
    const seenTargets = new Set<string>();
    let files = live ? live.contents.size + live.corruptFiles : 0;
    const maxChars = live?.definition.maxChars ?? entry.input.maxChars;
    return entry.folders.map((folder): PlannedFolder => {
      const none = { sourceDirectory: folder.directory, sourceKey: folder.sourceKey, basis: 'absent' as ImportBasis, overwritable: false };
      if (folder.problem) {
        return { ...none, key: `block:${name}#invalid-${folder.index}`, sourceDirectory: '', sourceKey: '', status: 'invalid', code: folder.problem.code, reason: folder.problem.message };
      }
      const key = `block:${name}#${folder.sourceKey}`;
      if ((keyCounts.get(folder.sourceKey) ?? 0) > 1) {
        return { ...none, key, status: 'invalid', code: 'DUPLICATE_KEY', reason: 'Two entries of this block name the same folder; keep one' };
      }
      if (live && live.definition.scope.kind !== 'project') return { ...none, key, status: 'skipped', code: 'BLOCK_SCOPE_IMMUTABLE', reason: 'A block with this name exists with the other scope' };
      if (live?.ambiguous) return { ...none, key, status: 'skipped', code: 'BLOCK_NAME_AMBIGUOUS', reason: 'More than one block uses this name' };
      if (live?.problem?.code === 'BLOCK_NOT_MIGRATED') return { ...none, key, status: 'invalid', code: 'BLOCK_NOT_MIGRATED', reason: live.problem.message };
      let target: string | undefined;
      if (context.mode === 'restore') target = folder.directory;
      else {
        const projectId = context.projectMap.get(folder.sourceKey);
        target = projectId ? dependencies.resolveProjectDirectory(projectId) ?? undefined : undefined;
      }
      if (!target) return { ...none, key, status: 'skipped', code: 'no-target-folder', reason: 'No project was chosen for this folder' };
      const targetKey = blockFolderOf(target).key;
      if (seenTargets.has(targetKey)) return { ...none, key, status: 'invalid', code: 'DUPLICATE_TARGET_FOLDER', reason: 'Another entry of this block already goes to the same project folder' };
      seenTargets.add(targetKey);
      if (folder.content.length > maxChars) return { ...none, key, status: 'invalid', code: 'BLOCK_TOO_LARGE', reason: `The text is longer than the block's limit of ${maxChars} characters` };
      const existing = live?.contents.get(targetKey);
      if (!existing) {
        if (files >= MAX_CONTENTS_PER_BLOCK) return { ...none, key, status: 'invalid', code: 'BLOCK_CONTENT_LIMIT_REACHED', reason: `A block can have text for at most ${MAX_CONTENTS_PER_BLOCK} folders` };
        // A file that exists but is unreadable would make the create fail: it is reported here, not found out at apply time.
        if (live && live.corruptFiles > 0) {
          try {
            store.getContent(live.definition.id, targetKey);
          } catch (error) {
            if (error instanceof AppError && error.code === 'PROFILE_CORRUPT') return { ...none, key, status: 'invalid', code: 'BLOCK_CONTENT_CORRUPT', reason: 'The stored text of this folder is unreadable' };
            throw error;
          }
        }
        files += 1;
        return { ...none, key, status: 'new', entry: folder, targetDirectory: target };
      }
      const status = existing.content === folder.content ? 'identical' : 'conflict';
      return {
        ...none, key, status, basis: existing.rev, entry: folder, targetDirectory: target,
        overwritable: status === 'conflict' && !live?.problem,
        ...(status === 'conflict' && live?.problem ? { code: live.problem.code, reason: live.problem.message } : {}),
      };
    });
  }

  function planBlocks(raw: RawAgentBundle, live: LiveState, context: { projectMap: Map<string, string>; mode: ImportMode }): PlannedItem[] {
    const validated = raw.memoryBlocks.map((entry, index) => validateBlockEntry(entry, index));
    const nameCounts = new Map<string, number>();
    for (const result of validated) if (result.name) nameCounts.set(result.name, (nameCounts.get(result.name) ?? 0) + 1);
    let created = 0;
    return validated.map((result, index): PlannedItem => {
      const key = `block:${result.name ?? `#${index}`}`;
      const base = { key, kind: 'block' as const, label: result.name ?? `Block ${index + 1}`, sensitive: [] as string[], basis: 'absent' as ImportBasis };
      if (!result.entry) {
        const [first] = errorsOf(result.problems);
        return { ...base, status: 'invalid', code: first?.code, overwritable: false, problems: result.problems };
      }
      const { entry } = result;
      if ((nameCounts.get(entry.name) ?? 0) > 1) {
        const problems = [...result.problems, { level: 'error' as const, code: 'DUPLICATE_KEY', message: `The block name "${entry.name}" appears more than once in this bundle`, path: `memoryBlocks[${index}].name` }];
        return { ...base, status: 'invalid', code: 'DUPLICATE_KEY', overwritable: false, problems };
      }
      const existing = live.blocks.get(entry.name);
      const item: PlannedItem = { ...base, status: 'new', overwritable: false, problems: result.problems, scope: entry.input.scope.kind, block: entry, liveBlock: existing };
      if (!existing) {
        if (live.allBlocks.length + created >= MAX_MEMORY_BLOCKS) {
          const problems = [...result.problems, { level: 'error' as const, code: 'BLOCK_LIMIT_REACHED', message: `At most ${MAX_MEMORY_BLOCKS} memory blocks can exist; delete one first`, path: `memoryBlocks[${index}]` }];
          return { ...base, status: 'invalid', code: 'BLOCK_LIMIT_REACHED', overwritable: false, problems };
        }
        created += 1;
      } else {
        const decided = definitionStatus(entry, existing);
        Object.assign(item, { status: decided.status, code: decided.code, overwritable: decided.overwritable, basis: existing.definition.rev });
      }
      if (entry.input.scope.kind === 'project' && entry.folders.length > 0) item.folders = planFolders(entry.name, entry, existing, context);
      return item;
    });
  }

  function buildPlan(raw: RawAgentBundle, live: LiveState, context: { projectMap: Map<string, string>; mode: ImportMode }): PlannedItem[] {
    return [...planTemplates(raw, live), ...planBlocks(raw, live, context)];
  }

  /** The item as a client sees it: no payload. */
  function publicItem(item: PlannedItem): ImportPlanItem {
    const {
      template: _template, liveTemplate: _liveTemplate, block: _block, liveBlock: _liveBlock, folders, ...visible
    } = item;
    return {
      ...visible,
      ...(folders ? { folders: folders.map(({ entry: _entry, targetDirectory: _target, ...row }) => row) } : {}),
    };
  }

  const publicPlan = (items: PlannedItem[]): ImportPlan => ({
    items: items.map(publicItem),
    hasFolderText: items.some((item) => (item.folders?.length ?? 0) > 0),
  });

  /** Dry run: what importing `raw` would do. Writes nothing. */
  function planImport(raw: RawAgentBundle, options: { projectMap?: Record<string, string> } = {}): ImportPlan {
    return publicPlan(buildPlan(raw, readLive(), { projectMap: cleanProjectMap(options.projectMap), mode: 'upload' }));
  }

  // ---------- apply ----------

  const allKeysOf = (items: PlannedItem[]): Set<string> => new Set(items.flatMap((item) => [item.key, ...(item.folders ?? []).map((folder) => folder.key)]));

  /**
   * Whether anything in the plan would really be overwritten (so a snapshot must exist first): a ticked, overwritable
   * conflict whose preview revision still matches (an upload) or any conflict (a restore). A refused tick takes no snapshot.
   */
  function overwrites(items: PlannedItem[], overwrite: Set<string>, basis: Record<string, ImportBasis>, mode: ImportMode): boolean {
    const goes = (row: { key: string; status: string; overwritable: boolean; basis: ImportBasis }): boolean =>
      row.status === 'conflict' && row.overwritable && overwrite.has(row.key) && (mode === 'restore' || basis[row.key] === row.basis);
    return items.some((item) => goes(item) || (item.folders ?? []).some(goes));
  }

  type ApplyContext = {
    overwrite: Set<string>;
    acceptSensitive: Set<string>;
    basis: Record<string, ImportBasis>;
    actor: ImportActor;
    mode: ImportMode;
  };

  /** Why a conflict may not be overwritten right now, or null when it may: not ticked, not overwritable, no basis, or changed since the preview. */
  function overwriteRefusal(
    row: { key: string; overwritable: boolean; basis: ImportBasis; code?: string; reason?: string }, context: ApplyContext,
  ): { status: 'skipped' | 'failed'; code: string; reason: string } | null {
    if (!context.overwrite.has(row.key)) return { status: 'skipped', code: 'CONFLICT', reason: 'Exists and differs; tick it to overwrite' };
    if (!row.overwritable) return { status: 'failed', code: row.code ?? 'NOT_OVERWRITABLE', reason: row.reason ?? 'This cannot be overwritten' };
    if (context.mode === 'restore') return null;
    const seen = context.basis[row.key];
    if (seen === undefined) return { status: 'failed', code: 'BASIS_REQUIRED', reason: 'Preview before overwriting: the preview tells which version you saw' };
    if (seen !== row.basis) return { status: 'failed', code: 'STALE', reason: 'Changed since the preview. Preview again before applying.' };
    return null;
  }

  function applyTemplate(item: PlannedItem, context: ApplyContext): ImportItemResult {
    const input = item.template as AgentProfileTemplateInput;
    if (item.status === 'identical') return { key: item.key, status: 'skipped', code: 'IDENTICAL' };
    if (item.sensitive.length > 0 && context.mode !== 'restore' && !context.acceptSensitive.has(item.key)) {
      return { key: item.key, status: 'skipped', code: 'SENSITIVE_NOT_ACCEPTED', reason: `Needs its own tick: ${item.sensitive.join(', ')}` };
    }
    try {
      if (item.status === 'new') {
        profiles.createTemplate(input);
        return { key: item.key, status: 'applied' };
      }
      const refusal = overwriteRefusal(item, context);
      if (refusal) return { key: item.key, ...refusal };
      profiles.updateTemplate((item.liveTemplate as AgentProfileTemplate).id, { ...input, rev: item.basis });
      return { key: item.key, status: 'applied' };
    } catch (error) {
      return { key: item.key, status: 'failed', ...describeFailure(error) };
    }
  }

  function applyFolder(row: PlannedFolder, blockId: string, context: ApplyContext): ImportFolderResult {
    if (row.status === 'invalid') return { key: row.key, status: 'failed', code: row.code, reason: row.reason };
    if (row.status === 'skipped') return { key: row.key, status: 'skipped', code: row.code, reason: row.reason };
    if (row.status === 'identical') return { key: row.key, status: 'skipped', code: 'IDENTICAL' };
    const entry = row.entry as ValidFolderEntry;
    if (context.actor.kind === 'agent') return { key: row.key, status: 'skipped', code: 'FOLDER_TEXT_HOST_ONLY', reason: 'Folder text can only be imported by the Host user' };
    try {
      if (row.status === 'new') {
        blocks.importFolderText(blockId, row.targetDirectory as string, entry.content, { writer: entry.writer });
        return { key: row.key, status: 'applied' };
      }
      const refusal = overwriteRefusal(row, context);
      if (refusal) return { key: row.key, ...refusal };
      blocks.importFolderText(blockId, row.targetDirectory as string, entry.content, { writer: entry.writer, expectedRev: row.basis as number });
      return { key: row.key, status: 'applied' };
    } catch (error) {
      return { key: row.key, status: 'failed', ...describeFailure(error, true) };
    }
  }

  function applyBlock(item: PlannedItem, context: ApplyContext): ImportItemResult {
    const entry = item.block as ValidBlockEntry;
    const { actor } = context;
    let result: ImportItemResult;
    let blockId: string | null = item.liveBlock?.definition.id ?? null;
    const body = {
      name: entry.name, description: entry.input.description, mode: entry.input.mode, scope: { kind: entry.input.scope.kind }, maxChars: entry.input.maxChars,
    };
    try {
      if (item.status === 'identical') {
        result = { key: item.key, status: 'skipped', code: 'IDENTICAL' };
      } else if (item.status === 'new') {
        const writer = writerFor(actor, entry.writer);
        const created = blocks.create(entry.input.scope.kind === 'global' ? { ...body, content: entry.text ?? '' } : body, writer);
        blockId = created.block.id;
        result = { key: item.key, status: 'applied' };
      } else {
        const refusal = overwriteRefusal(item, context);
        const live = item.liveBlock as LiveBlock;
        if (refusal) {
          result = { key: item.key, ...refusal };
        } else if (actor.kind === 'agent' && live.definition.mode === 'read-only') {
          result = { key: item.key, status: 'failed', code: 'BLOCK_READ_ONLY', reason: `Memory block "${entry.name}" is read-only: only the user can change it` };
        } else {
          const isGlobal = live.definition.scope.kind === 'global';
          // A bundle without text keeps the stored text: the service replaces the whole block, so the current text is passed back.
          const content = isGlobal ? entry.text ?? live.definition.content : undefined;
          blocks.update(live.definition.id, { ...body, ...(isGlobal ? { content } : {}), expectedRev: item.basis }, writerFor(actor, entry.writer));
          result = { key: item.key, status: 'applied' };
        }
      }
    } catch (error) {
      result = { key: item.key, status: 'failed', ...describeFailure(error) };
    }
    if (item.folders && item.folders.length > 0) {
      const folders = item.folders.map((row): ImportFolderResult => (
        result.status === 'failed' || blockId === null
          ? { key: row.key, status: 'skipped', code: 'DEFINITION_NOT_APPLIED', reason: 'The block itself was not imported' }
          : applyFolder(row, blockId, context)
      ));
      result.folders = folders;
      if (folders.some((folder) => folder.status === 'failed' || (folder.status === 'skipped' && folder.code !== 'IDENTICAL'))) result.partial = true;
    }
    return result;
  }

  function apply(raw: RawAgentBundle, options: ImportOptions, mode: ImportMode): ImportResult {
    const actor: ImportActor = options.actor ?? { kind: 'user' };
    if (actor.kind === 'agent' && !actor.name.trim()) throw new AppError('An agent actor needs a name', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
    const projectMap = cleanProjectMap(options.projectMap);
    // Stage 1: the legacy block migration runs here, once, before anything is compared.
    const liveBefore = readLive();
    const before = buildPlan(raw, liveBefore, { projectMap, mode });
    const overwrite = mode === 'restore' ? allKeysOf(before) : new Set(options.overwrite ?? []);
    // Stage 2: snapshot first (it reads every block), then the plan the writes use, then the writes: no await in between.
    let snapshot: string | null = null;
    if (overwrites(before, overwrite, options.basis ?? {}, mode)) {
      if (liveBefore.corruptRecords > 0) {
        throw new AppError(
          'Some stored templates or blocks are unreadable, so a backup would be incomplete. Nothing was changed; repair or delete those files first.',
          { code: 'SNAPSHOT_UNAVAILABLE', statusCode: 409 },
        );
      }
      snapshot = snapshots.write(exportFrom(liveBefore, { includeBlockContent: true }).bundle);
    }
    const plan = buildPlan(raw, readLive(), { projectMap, mode });
    const context: ApplyContext = {
      overwrite: mode === 'restore' ? allKeysOf(plan) : overwrite,
      acceptSensitive: new Set(options.acceptSensitive ?? []),
      basis: options.basis ?? {},
      actor,
      mode,
    };
    const items = plan.map((item): ImportItemResult => {
      if (item.status === 'invalid') {
        const [first] = errorsOf(item.problems);
        return { key: item.key, status: 'failed', code: item.code ?? first?.code, reason: first?.message };
      }
      return item.kind === 'template' ? applyTemplate(item, context) : applyBlock(item, context);
    });
    const partial = items.some((item) => item.status === 'failed' || (item.status === 'skipped' && item.code !== 'IDENTICAL') || item.partial === true);
    return { items, partial, snapshot };
  }

  /** Applies a bundle: only what is ticked is overwritten, a snapshot is taken first when anything is, an item that fails never stops the others. */
  function applyImport(raw: RawAgentBundle, options: ImportOptions = {}): ImportResult {
    return apply(raw, options, 'upload');
  }

  // ---------- text entry points (routes) ----------

  /** Adds the line and column of each problem's path in the source text. */
  function locateProblems(plan: ImportPlan, parsed: ParsedBundleText): ImportPlan {
    const place = (problem: ImportProblem): ImportProblem => {
      const position = problem.path ? parsed.locate(problem.path) : null;
      return position ? { ...problem, line: position.line, column: position.column } : problem;
    };
    return { ...plan, items: plan.items.map((item) => ({ ...item, problems: item.problems.map(place) })) };
  }

  /** Dry run of a bundle written as YAML or JSON text; syntax and envelope errors are `BUNDLE_INVALID` with line and column. */
  function previewText(text: string, options: { projectMap?: Record<string, string> } = {}): ImportPlan {
    const parsed = parseBundleText(text);
    return locateProblems(planImport(parsed.bundle, options), parsed);
  }

  /** Applies a bundle written as YAML or JSON text. */
  function applyText(text: string, options: ImportOptions = {}): ImportResult {
    return applyImport(parseBundleText(text).bundle, options);
  }

  /** The export as a downloadable file: YAML by default. */
  function exportText(options: { templateIds?: string[]; blockIds?: string[]; includeBlockContent?: boolean; format?: 'yaml' | 'json' } = {}): { filename: string; text: string; problems: ExportProblem[] } {
    const format = options.format ?? 'yaml';
    const { bundle, problems } = exportBundle(options);
    const day = now().toISOString().slice(0, 10).replace(/-/g, '');
    return { filename: `remotecli-agent-bundle-${day}.${format}`, text: serializeBundle(bundle, format), problems };
  }

  // ---------- snapshots ----------

  const listSnapshots = (): AgentBundleSnapshot[] => snapshots.list();

  /**
   * Puts back what a snapshot (named by file name, a file this server wrote) holds: overwritten items are reverted, deleted
   * ones re-created, folder text goes back to the folder it was stored for, items created since are kept. It takes its own
   * snapshot first like any overwrite. A block now under the other scope kind, or one not moved to per-folder content, is
   * skipped with its code.
   */
  function restoreSnapshot(name: string, options: { actor?: ImportActor } = {}): ImportResult {
    return apply(parseBundleText(snapshots.read(name)).bundle, { actor: options.actor }, 'restore');
  }

  return {
    exportBundle, exportText, planImport, applyImport, previewText, applyText, listSnapshots, restoreSnapshot,
  };
}

/** Bundle service type the routes depend on. Consumed by: agent-profiles.routes.ts. */
export type BundleService = ReturnType<typeof createBundleService>;
