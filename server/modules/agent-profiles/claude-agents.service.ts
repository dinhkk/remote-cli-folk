import fs from 'node:fs/promises';
import path from 'node:path';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import { AppError, isValidAgentProfileName } from '@/shared/utils.js';
import type {
  AgentProfileTemplate,
  ClaudeAgentEntry,
  ClaudeAgentSource,
  ClaudeSdkAgentInfo,
  ScopeAgentOption,
} from '@/shared/types.js';

import { MAX_AGENT_FILE_BYTES, readGeneratedMarker } from './agent-profiles.generator.js';
import type { AgentProfileStore } from './agent-profiles.store.js';
import { parseDirectory, parseExpectedRev, parseHiddenNames, parseManagerNames } from './agent-profiles.validation.js';

const BUILTIN_CACHE_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_MS = 60 * 1000;

/** The agent name the scope picker flags as the orchestrator (the slug of the sample orchestrator template). */
const ORCHESTRATOR_AGENT_NAME = 'orchestrator';

/** Shown when the SDK cannot be asked; the built-ins Claude Code ships (SDK 0.3.x). */
const FALLBACK_BUILTIN_AGENTS: readonly ClaudeSdkAgentInfo[] = [
  { name: 'general-purpose', description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.' },
  { name: 'Explore', description: 'Fast read-only agent for searching and exploring a codebase.' },
  { name: 'Plan', description: 'Software architect agent for designing implementation plans.' },
  { name: 'claude', description: 'Catch-all agent for tasks that do not fit a more specific agent.' },
  { name: 'statusline-setup', description: 'Configures the Claude Code status line setting.' },
];

type ClaudeAgentsDependencies = {
  store: AgentProfileStore;
  /** Claude Code's user directory (`~/.claude`); its `agents/` folder holds user agents. */
  claudeHomeDirectory: string;
  /** Asks Claude Code for its agents (a temporary SDK query); injected so tests never reach a model. */
  listSdkAgents: () => Promise<ClaudeSdkAgentInfo[]>;
  now?: () => number;
  /** Hard limit on one SDK lookup, whatever the adapter does; defaults to 10 s. */
  builtinTimeoutMs?: number;
};

type BuiltinCacheEntry = { at: number; ttl: number; agents: ClaudeSdkAgentInfo[]; source: 'sdk' | 'fallback' };

/** Result of the listing: entries plus what the hide request must echo back and where built-ins came from. */
type ClaudeAgentListing = {
  items: ClaudeAgentEntry[];
  /** `rev` of the hide list; send it back with `PUT /claude-agents/hidden`. */
  hiddenRev: number;
  /** The stored hide list exactly as saved, including names no listed agent has; a client edits this list, never one rebuilt from `items`. */
  hiddenNames: string[];
  /** Main agents allowed to use the `profiles` tools, exactly as saved; shares `hiddenRev` (one settings revision). */
  managerNames: string[];
  builtinSource: 'sdk' | 'fallback';
};

const frontmatterString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function frontmatterList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const list = items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Settles with `promise`, or rejects after `ms` (the timer is always cleared). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The single source listing agents: what Claude Code provides (built-in, `~/.claude/agents`,
 * `<directory>/.claude/agents` for a project folder given by the caller), each file marked
 * generated (carries the RemoteCLI marker) or handmade; the hide list that keeps some of them
 * out of new sessions; and the name-only main-agent list of the scope picker. Nothing here writes
 * to any `.claude` directory; the hide list lives in the module's own `settings.json`.
 * Consumed by: agent-profiles.routes.ts, agent-profiles.service.ts (the scope picker's
 * `listMainAgents`) and agent-profiles.session-scope.ts (does the chosen agent exist, hidden names). */
export function createClaudeAgentsService(dependencies: ClaudeAgentsDependencies) {
  const { store, claudeHomeDirectory, listSdkAgents } = dependencies;
  const now = dependencies.now ?? Date.now;
  const builtinTimeoutMs = dependencies.builtinTimeoutMs ?? 10_000;
  let builtinCache: BuiltinCacheEntry | null = null;
  let builtinInFlight: Promise<BuiltinCacheEntry> | null = null;

  /** Built-in agents from the SDK, cached; any failure yields the static list (cached briefly). */
  async function loadBuiltins(): Promise<BuiltinCacheEntry> {
    if (builtinCache && now() - builtinCache.at < builtinCache.ttl) return builtinCache;
    builtinInFlight ??= (async () => {
      try {
        // Backstop: a lookup that never settles must not leave this in-flight promise (and every caller) hanging.
        const agents = await withTimeout(listSdkAgents(), builtinTimeoutMs);
        builtinCache = { at: now(), ttl: BUILTIN_CACHE_MS, agents, source: 'sdk' };
      } catch {
        builtinCache = { at: now(), ttl: FALLBACK_CACHE_MS, agents: [...FALLBACK_BUILTIN_AGENTS], source: 'fallback' };
      }
      return builtinCache;
    })().finally(() => { builtinInFlight = null; });
    return builtinInFlight;
  }

  /** Entries for every `*.md` in `directory`; a missing directory is empty, a bad file becomes an `error` entry. */
  async function readAgentFiles(directory: string, source: ClaudeAgentSource): Promise<ClaudeAgentEntry[]> {
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.toLowerCase().endsWith('.md')).sort();
    } catch {
      return [];
    }
    return Promise.all(names.map(async (fileName): Promise<ClaudeAgentEntry> => {
      const fallbackName = fileName.slice(0, -'.md'.length);
      try {
        const file = path.join(directory, fileName);
        if ((await fs.stat(file)).size > MAX_AGENT_FILE_BYTES) throw new Error('file is too large to read');
        const text = await fs.readFile(file, 'utf8');
        const parsed = parseFrontMatter(text);
        const name = frontmatterString(parsed.data.name);
        if (!name) throw new Error('front matter has no "name"');
        // Same strict rule as the generator's regenerate decision: the marker must name this file's own slug.
        const generatedFrom = readGeneratedMarker(text, fallbackName);
        const entry: ClaudeAgentEntry = {
          source, name, description: frontmatterString(parsed.data.description), prompt: parsed.content.trim(), hidden: false,
          generated: generatedFrom !== null, path: file,
          ...(generatedFrom !== null ? { generatedFrom } : {}),
        };
        const tools = frontmatterList(parsed.data.tools);
        const model = frontmatterString(parsed.data.model);
        if (tools) entry.tools = tools;
        if (model) entry.model = model;
        return entry;
      } catch (error) {
        return {
          source, name: fallbackName, description: '', hidden: false, generated: false,
          path: path.join(directory, fileName), error: (error as Error).message,
        };
      }
    }));
  }

  /**
   * Template slug -> dropdown group, for the templates that have one. The store being unreadable only costs the
   * headings (the picker still lists every agent), so a failure is an empty map, not an error.
   */
  function templateGroups(): Map<string, string> {
    const groups = new Map<string, string>();
    try {
      for (const template of store.list<AgentProfileTemplate>('templates').items) {
        if (template.group) groups.set(template.slug, template.group);
      }
    } catch {
      // No headings this time.
    }
    return groups;
  }

  /** Agent files of the user folder plus, when `directory` is given (an absolute path, else 400), of the project folder. */
  async function readScopeFiles(directory: string | null | undefined): Promise<ClaudeAgentEntry[]> {
    const projectDirectory = parseDirectory(directory);
    return [
      ...await readAgentFiles(path.join(claudeHomeDirectory, 'agents'), 'user'),
      ...(projectDirectory ? await readAgentFiles(path.join(projectDirectory, '.claude', 'agents'), 'project') : []),
    ];
  }

  /** Lists user agents, the project folder's agents and the built-ins (a built-in a file shadows by name is left out). */
  async function list(directory?: string | null): Promise<ClaudeAgentListing> {
    const settings = store.readSettings();
    const hidden = new Set(settings.hiddenClaudeAgents);
    const files = await readScopeFiles(directory);
    const fileNames = new Set(files.map((entry) => entry.name.toLowerCase()));
    const builtins = await loadBuiltins();
    const builtinEntries = builtins.agents
      .filter((agent) => !fileNames.has(agent.name.toLowerCase()))
      .map((agent): ClaudeAgentEntry => ({
        source: 'builtin', name: agent.name, description: agent.description, hidden: false, generated: false,
        ...(agent.model ? { model: agent.model } : {}),
      }));
    const items = [...builtinEntries, ...files].map((entry) => ({ ...entry, hidden: hidden.has(entry.name) }));
    return {
      items, hiddenRev: settings.rev, hiddenNames: settings.hiddenClaudeAgents, managerNames: settings.profileManagerAgents, builtinSource: builtins.source,
    };
  }

  return {
    list,

    /**
     * Whether `name` is a readable agent file in the user folder or, when `directory` is given, the project
     * folder. Built-ins do not count. Reads those two folders only, never the SDK.
     */
    async hasAgentFile(name: string, directory?: string | null): Promise<boolean> {
      return (await readScopeFiles(directory)).some((entry) => entry.name === name && !entry.error);
    },

    /** Names on the saved hide list, exactly as stored (including names no listed agent has). */
    hiddenNames(): string[] {
      return store.readSettings().hiddenClaudeAgents;
    },

    /** Saves the hide list (`{names, rev}`); a stale `rev` is refused with 409. */
    setHidden(body: unknown): { hiddenClaudeAgents: string[]; rev: number } {
      const names = parseHiddenNames(body);
      const saved = store.updateSettings({ hiddenClaudeAgents: names }, parseExpectedRev(body));
      return { hiddenClaudeAgents: saved.hiddenClaudeAgents, rev: saved.rev };
    },

    /** Main agents allowed to use the `profiles` tools, exactly as saved. A malformed settings file throws `PROFILE_CORRUPT`. */
    managerNames(): string[] {
      return store.readSettings().profileManagerAgents;
    },

    /** Saves the manager list (`{names, rev}`, `rev` is the settings revision the hide list shares); a stale `rev` is refused with 409. */
    setManagers(body: unknown): { profileManagerAgents: string[]; rev: number } {
      const names = parseManagerNames(body);
      const saved = store.updateSettings({ profileManagerAgents: names }, parseExpectedRev(body));
      return { profileManagerAgents: saved.profileManagerAgents, rev: saved.rev };
    },

    /**
     * Deletes one generated agent file: `<claude home>/agents/<name>.md` (scope `user`) or
     * `<directory>/.claude/agents/<name>.md` (scope `project`). The path is built here from the name, never taken from the client,
     * and only a file that still carries the generator marker naming `name` is removed: a handmade file (or one the user
     * took over by removing the marker) answers 409 and stays. A missing file is 404.
     */
    async deleteGenerated(scope: unknown, name: unknown, directory?: unknown): Promise<{ deleted: true }> {
      if (scope !== 'user' && scope !== 'project') {
        throw new AppError('scope must be "user" or "project"', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
      }
      if (typeof name !== 'string' || !isValidAgentProfileName(name)) {
        throw new AppError('name is not a valid agent name', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
      }
      const projectDirectory = scope === 'project' ? parseDirectory(directory) : null;
      if (scope === 'project' && !projectDirectory) {
        throw new AppError('directory is required for a project agent', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
      }
      const agentsDirectory = projectDirectory
        ? path.join(projectDirectory, '.claude', 'agents')
        : path.join(claudeHomeDirectory, 'agents');
      const file = path.join(agentsDirectory, `${name}.md`);
      let text: string;
      try {
        const stats = await fs.stat(file);
        if (!stats.isFile() || stats.size > MAX_AGENT_FILE_BYTES) throw new Error('not a readable agent file');
        text = await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new AppError('Agent file not found', { code: 'PROFILE_NOT_FOUND', statusCode: 404 });
        }
        throw new AppError('The agent file cannot be read, so it was not deleted', { code: 'AGENT_NOT_GENERATED', statusCode: 409 });
      }
      if (readGeneratedMarker(text, name) === null) {
        throw new AppError('Only agent files generated from a template can be deleted here', { code: 'AGENT_NOT_GENERATED', statusCode: 409 });
      }
      await fs.rm(file, { force: true });
      return { deleted: true };
    },

    /**
     * Whether a chat started in `directory` with main agent `name` runs the user-level generated agent file
     * (`~/.claude/agents/<name>.md` with the generator marker naming that same slug). A project file of the same name shadows
     * the user file in Claude Code, so any project entry with that name (readable or not) disqualifies. Reads files only.
     * Throws when `directory` is not an absolute path; callers on the run path treat a throw as "no".
     */
    async isUserGeneratedAgent(name: string, directory?: string | null): Promise<boolean> {
      if (!isValidAgentProfileName(name)) return false;
      const matching = (await readScopeFiles(directory)).filter((entry) => entry.name === name);
      if (matching.some((entry) => entry.source === 'project')) return false;
      return matching.some((entry) => entry.source === 'user' && !entry.error && entry.generatedFrom === name);
    },

    /**
     * The main agents a new chat in the project folder `directory` can start with, for the Remote-safe
     * scope picker: readable agent files of the project's `.claude/agents` and of `~/.claude/agents`, minus the
     * hidden ones and the names `POST /sessions` would refuse (`isValidAgentProfileName`). A project file shadows a user file of the same name (Claude Code's own precedence), so
     * a name appears once. Files only: never starts the SDK/CLI, and returns names, never paths or prompts.
     * Project agents first, each group sorted by name.
     */
    async listMainAgents(directory: string): Promise<ScopeAgentOption[]> {
      const hidden = new Set(store.readSettings().hiddenClaudeAgents);
      const groups = templateGroups();
      const agents = new Map<string, ScopeAgentOption>();
      // `readScopeFiles` returns the user folder first, so a project entry with the same name replaces it.
      for (const entry of await readScopeFiles(directory)) {
        // A name `POST /sessions` would refuse (spaces, dots, over 64 characters...) is not offered: picking it would only fail.
        if (entry.error || hidden.has(entry.name) || !isValidAgentProfileName(entry.name)) continue;
        // The heading comes from the template a generated file carries the marker of; handmade files have none.
        const group = entry.generatedFrom ? groups.get(entry.generatedFrom) : undefined;
        agents.set(entry.name, {
          name: entry.name,
          source: entry.source === 'project' ? 'project' : 'user',
          isOrchestrator: entry.name === ORCHESTRATOR_AGENT_NAME,
          ...(group ? { group } : {}),
        });
      }
      const rank = (agent: ScopeAgentOption): number => (agent.source === 'project' ? 0 : 1);
      return [...agents.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    },
  };
}

/** Service type the service and routes depend on. Consumed by: agent-profiles.service.ts, agent-profiles.routes.ts, session scope. */
export type ClaudeAgentsService = ReturnType<typeof createClaudeAgentsService>;
