import fs from 'node:fs/promises';
import path from 'node:path';

import { AppError, assertValidProfileId, normalizeProjectPath } from '@/shared/utils.js';
import type {
  AgentProfileList,
  AgentProfileTemplate,
  GenerateAgentsPreview,
  GenerateAgentsResult,
  GenerateRememberedValues,
  GenerateScope,
  ScopeOptions,
} from '@/shared/types.js';

import { addGitExcludeEntries } from './agent-profiles.git-exclude.js';
import { planGeneration, writeGeneration, type PlannedAgentFile } from './agent-profiles.generator.js';
import type { GenerateProjectContext } from './agent-profiles.resolve.js';
import { valuesKeyOf, type AgentProfileStore } from './agent-profiles.store.js';
import {
  parseDirectory, parseExpectedRev, parseGenerateRequest, parseProjectId, parseTemplateInput,
} from './agent-profiles.validation.js';
import type { ClaudeAgentsService } from './claude-agents.service.js';

type AgentProfilesDependencies = {
  store: AgentProfileStore;
  claudeAgents: ClaudeAgentsService;
  /** Claude Code's user directory (`~/.claude`): the global Generate scope writes to its `agents/` folder. */
  claudeHomeDirectory: string;
  /** Folder of a sidebar project by its id (the app database's project id), null when no such project. */
  resolveProjectDirectory: (projectId: string) => string | null;
};

const notFound = (what: string): AppError => new AppError(`${what} not found`, { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
const conflict = (message: string, code: string, details?: unknown): AppError =>
  new AppError(message, { code, statusCode: 409, details });

/**
 * A stored template as the API returns it. Files written by older versions may still carry
 * `isDefaultOrchestrator` and `origin`; they are left in the file but never returned.
 */
function publicTemplate(record: AgentProfileTemplate): AgentProfileTemplate {
  const template: Record<string, unknown> = { ...record };
  delete template.isDefaultOrchestrator;
  delete template.origin;
  return template as AgentProfileTemplate;
}

/**
 * Checks that a Generate target folder is an existing directory. The messages never name the folder: the
 * route is Host-only today, but the error text should stay free of host paths regardless.
 */
async function assertExistingDirectory(directory: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(directory);
  } catch {
    throw new AppError('The project folder does not exist.', { code: 'DIRECTORY_NOT_FOUND', statusCode: 400 });
  }
  if (!stats.isDirectory()) throw new AppError('The project folder is not a folder.', { code: 'DIRECTORY_NOT_A_DIRECTORY', statusCode: 400 });
}

/** Everything a Generate run resolved from its request before touching any file. */
type PreparedGeneration = {
  scope: GenerateScope;
  /** Normalized project folder; null for the global scope. */
  directory: string | null;
  agentsDirectory: string;
  project: GenerateProjectContext | null;
  templates: AgentProfileTemplate[];
  planned: PlannedAgentFile[];
  typedValues: Record<string, string>;
};

/**
 * Templates, the Generate flow (template -> native agent file in a project folder or
 * `~/.claude/agents`), the values remembered per folder, and the scope picker data. Validation,
 * uniqueness and stale-write rules live here; persistence is the store's; text rendering is the
 * generator's.
 * Consumed by: agent-profiles.routes.ts (via agent-profiles.module.ts).
 */
export function createAgentProfilesService(dependencies: AgentProfilesDependencies) {
  const { store, claudeAgents } = dependencies;

  const templates = (): AgentProfileList<AgentProfileTemplate> => {
    const listed = store.list<AgentProfileTemplate>('templates');
    return { ...listed, items: listed.items.map(publicTemplate) };
  };

  function requireTemplate(id: string): AgentProfileTemplate {
    assertValidProfileId(id);
    const found = store.get<AgentProfileTemplate>('templates', id);
    if (!found) throw notFound('Template');
    return publicTemplate(found);
  }

  const refuseDuplicateSlug = (slug: string, selfId?: string): void => {
    if (templates().items.some((template) => template.id !== selfId && template.slug === slug)) {
      throw conflict(`Slug "${slug}" is already used`, 'SLUG_TAKEN');
    }
  };

  // ---------- Generate ----------

  /** Validates the request, resolves the target folder and plans every chosen template (reads the folder, writes nothing). */
  async function prepareGeneration(body: unknown): Promise<PreparedGeneration> {
    const request = parseGenerateRequest(body);
    const chosen = request.templateIds.map((templateId) => requireTemplate(templateId));
    let directory: string | null = null;
    if (request.directory) {
      await assertExistingDirectory(request.directory);
      directory = normalizeProjectPath(path.resolve(request.directory));
    }
    const project = directory ? { name: request.projectName ?? path.basename(directory), directory } : null;
    const agentsDirectory = directory
      ? path.join(directory, '.claude', 'agents')
      : path.join(dependencies.claudeHomeDirectory, 'agents');
    const planned = await planGeneration({ agentsDirectory, project, templates: chosen, values: request.values });
    return {
      scope: directory ? 'project' : 'user', directory, agentsDirectory, project, templates: chosen, planned, typedValues: request.values,
    };
  }

  /**
   * Remembers the values typed at Generate for the folder: only keys the chosen templates declare, a key sent
   * empty is forgotten, keys not sent (and other templates' keys) stay as they were.
   */
  function rememberValues(prepared: PreparedGeneration): void {
    const key = valuesKeyOf(prepared.directory);
    const remembered = store.readRememberedValues(key);
    for (const template of prepared.templates) {
      for (const param of template.params) {
        if (!Object.hasOwn(prepared.typedValues, param.key)) continue;
        const typed = prepared.typedValues[param.key];
        if (typed.trim()) remembered[param.key] = typed;
        else delete remembered[param.key];
      }
    }
    store.writeRememberedValues(key, remembered);
  }

  /** Lines for the repository's exclude file: each written agent file, plus the memory folders the written agents use. */
  function excludeEntriesFor(written: readonly PlannedAgentFile[]): string[] {
    const entries = written.map((item) => `.claude/agents/${item.plan.name}.md`);
    if (written.some((item) => item.template.memory === 'project')) entries.push('.claude/agent-memory/');
    if (written.some((item) => item.template.memory === 'local')) entries.push('.claude/agent-memory-local/');
    return entries;
  }

  return {
    // ---------- templates ----------
    listTemplates: () => templates(),
    getTemplate: (id: string) => requireTemplate(id),

    createTemplate(body: unknown): AgentProfileTemplate {
      const input = parseTemplateInput(body);
      refuseDuplicateSlug(input.slug);
      return store.insert<AgentProfileTemplate>('templates', input);
    },

    updateTemplate(id: string, body: unknown): AgentProfileTemplate {
      const input = parseTemplateInput(body);
      const rev = parseExpectedRev(body);
      requireTemplate(id);
      refuseDuplicateSlug(input.slug, id);
      // The record is rebuilt from the input alone, so `isDefaultOrchestrator` / `origin` of an old file drop out here.
      return store.update<AgentProfileTemplate>('templates', id, rev, () => input);
    },

    deleteTemplate(id: string): { deleted: true } {
      requireTemplate(id);
      // Generated agent files are plain files: deleting their template leaves them as they are.
      store.remove('templates', id);
      return { deleted: true };
    },

    // ---------- Generate ----------
    /** Values remembered for a project folder (`directory` query value; absent/blank = the global scope). */
    getRememberedValues(directory: unknown): GenerateRememberedValues {
      const parsed = parseDirectory(directory);
      const normalized = parsed ? normalizeProjectPath(path.resolve(parsed)) : null;
      return { directory: normalized, values: store.readRememberedValues(valuesKeyOf(normalized)) };
    },

    /** Plans one agent file per chosen template for the target folder; writes nothing (neither files nor remembered values). */
    async previewGenerate(body: unknown): Promise<GenerateAgentsPreview> {
      const { scope, agentsDirectory, planned } = await prepareGeneration(body);
      return { scope, agentsDirectory, plans: planned.map((item) => item.plan) };
    },

    /**
     * Remembers the typed values for the folder, writes the `new` and `duplicate` (regenerate) files of the
     * plan, and for a project folder inside a git repository appends the written files (and agent memory
     * folders) to the repository's local exclude file. Files without the marker are never touched. The values
     * are saved first so an unreadable values file fails the request before any agent file is written.
     */
    async generate(body: unknown): Promise<GenerateAgentsResult> {
      const prepared = await prepareGeneration(body);
      rememberValues(prepared);
      const written = await writeGeneration(prepared.planned);
      const changed = [...written.created, ...written.regenerated];
      const gitExclude = prepared.directory && changed.length > 0
        ? await addGitExcludeEntries(prepared.directory, excludeEntriesFor(changed))
        : { file: null, added: [] };
      return {
        scope: prepared.scope,
        agentsDirectory: prepared.agentsDirectory,
        created: written.created.map((item) => item.plan),
        regenerated: written.regenerated.map((item) => item.plan),
        skipped: written.skipped.map((item) => item.plan),
        gitExclude,
      };
    },

    // ---------- scope picker ----------
    /**
     * What the Remote-safe scope picker may see for one sidebar project: the main agents a new chat there can
     * start with (names, source, orchestrator flag; see `ScopeAgentOption`). The folder is resolved here from
     * the project id; no path, description, prompt or value ever leaves, and an unknown id is a plain 404
     * that does not echo anything back.
     */
    async scopeOptions(projectId: unknown): Promise<ScopeOptions> {
      const directory = dependencies.resolveProjectDirectory(parseProjectId(projectId));
      if (!directory) throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      return { agents: await claudeAgents.listMainAgents(directory) };
    },
  };
}

/** Service type the routes depend on. Consumed by: agent-profiles.routes.ts. */
export type AgentProfilesService = ReturnType<typeof createAgentProfilesService>;
