import { vi } from 'vitest';

import type {
  AgentProfileTemplate,
  ClaudeAgentEntry,
  GenerateTargetProject,
  MemoryBlock,
  MemoryBlockInput,
  MemoryBlockProjectContent,
} from '@/shared/types';

/**
 * A stand-in for `/api/agent-profiles/*` (and the picker catalogs), installed as the global `fetch`. Tests register
 * one handler per `METHOD /path` (`:id` segments match anything) and read back every request the UI made, so they
 * assert on what went over the wire.
 */

export type FakeCall = { method: string; path: string; body: Record<string, unknown> | null };
export type FakeReply = { status?: number; body?: unknown };
type FakeHandler = (call: FakeCall) => FakeReply | Promise<FakeReply>;

/** A JSON answer with the given status (200 by default). */
export const reply = (body: unknown, status = 200): FakeReply => ({ status, body });

/** The server's error envelope: `{ success: false, error: { code, message, details } }`. */
export const failure = (status: number, code: string, message = code, details?: unknown): FakeReply => ({
  status,
  body: { success: false, error: { code, message, details } },
});

const matches = (pattern: string, path: string): boolean => {
  const want = pattern.split('/');
  const have = path.split('/');
  return want.length === have.length && want.every((part, index) => part.startsWith(':') || part === have[index]);
};

export const installFakeProfilesApi = (initial: Record<string, FakeHandler | FakeReply> = {}) => {
  const handlers = new Map<string, FakeHandler>();
  const calls: FakeCall[] = [];
  const set = (route: string, handler: FakeHandler | FakeReply) => {
    handlers.set(route, typeof handler === 'function' ? handler : () => handler);
  };
  for (const [route, handler] of Object.entries(initial)) set(route, handler);

  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input);
    const call: FakeCall = { method, path, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    const route = [...handlers.keys()].find((key) => {
      const [routeMethod, routePath] = key.split(' ');
      return routeMethod === method && matches(routePath ?? '', path.split('?')[0] ?? '');
    });
    if (!route) return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'not found' } }), { status: 404 });
    const answer = await handlers.get(route)!(call);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }));

  return {
    calls,
    set,
    /** Requests that matched `METHOD /path` exactly (query string included in `path`). */
    to: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path),
  };
};

// ---------- record fixtures ----------

const META = { rev: 1, updatedAt: '2026-11-21T00:00:00.000Z' };

export const makeTemplate = (overrides: Partial<AgentProfileTemplate> & { id: string }): AgentProfileTemplate => ({
  ...META,
  slug: overrides.id,
  family: 'worker',
  name: overrides.id,
  description: 'Does a job.',
  instructions: 'Do the job.',
  params: [],
  bindings: { project: true, knowledge: false },
  ...overrides,
});

export const makeClaudeAgent = (overrides: Partial<ClaudeAgentEntry> & { name: string }): ClaudeAgentEntry => ({
  source: 'builtin',
  description: 'A Claude agent.',
  hidden: false,
  generated: false,
  ...overrides,
});

/** The standard fixture set: a reviewer template with a required git URL, an orchestrator template, and two sidebar projects. */
export const REVIEW_TEMPLATE = makeTemplate({
  id: 't-review',
  slug: 'review-code',
  name: 'Code reviewer',
  instructions: 'Review {{git_url}} following {{guideline}}.',
  params: [
    { key: 'git_url', type: 'url', title: 'Git URL', description: 'Where the code lives.', required: true },
    { key: 'guideline', type: 'text', title: 'Guidelines', description: '', required: false, default: 'be kind' },
  ],
});
export const ORCHESTRATOR_TEMPLATE = makeTemplate({
  id: 't-orch',
  slug: 'default-orchestrator',
  name: 'Orchestrator',
  family: 'orchestrator',
});
/** Sidebar projects as the settings dialog hands them to the Agent Profiles panel. */
export const SIDEBAR_ALPHA: GenerateTargetProject = { projectId: 'sp-alpha', name: 'Alpha', directory: '/work/alpha' };
export const SIDEBAR_CRM: GenerateTargetProject = { projectId: 'sp-crm', name: 'CRM', directory: 'C:\\Work\\CRM' };

export const makeMemoryBlock = (overrides: Partial<MemoryBlock> & { id: string }): MemoryBlock => ({
  ...META,
  name: overrides.id,
  description: '',
  mode: 'writable',
  scope: { kind: 'global' },
  content: '',
  maxChars: 2000,
  lastWriter: null,
  ...overrides,
});

export const makeProjectContent = (overrides: Partial<MemoryBlockProjectContent> & { directory: string }): MemoryBlockProjectContent => ({
  content: '',
  rev: 1,
  lastWriter: null,
  updatedAt: '2026-11-21T00:00:00.000Z',
  ...overrides,
});

/**
 * Stateful handlers of `/api/agent-profiles/memory-blocks` that behave like the server: list sorted by name, create (201,
 * `BLOCK_NAME_TAKEN` across all scopes; a project block keeps no content), update (`expectedRev` must match, else 409
 * `PROFILE_STALE`; the rev moves on; a rename into another block's name is `BLOCK_NAME_TAKEN`; the scope kind cannot change), delete,
 * and the per-folder content of project blocks (list, add = empty file, edit with its own `expectedRev`, empty = keep file and
 * bump `rev`, `?remove=true` = drop the file and continue its `rev` on a later add).
 * Pass the result to `installFakeProfilesApi` / `api.set`; `blocks` and `contents` (block id -> files) are the live stores the
 * test can read back.
 */
export const memoryBlockRoutes = (initial: MemoryBlock[] = [], initialContents: Record<string, MemoryBlockProjectContent[]> = {}) => {
  const blocks = [...initial];
  const contents: Record<string, MemoryBlockProjectContent[]> = Object.fromEntries(
    Object.entries(initialContents).map(([id, items]) => [id, [...items]]),
  );
  const tombs = new Map<string, number>();
  let nextId = 1;
  const query = (call: FakeCall) => new URLSearchParams(call.path.split('?')[1] ?? '');
  const blockIdOf = (call: FakeCall): string => call.path.split('?')[0]!.split('/')[4]!;
  const files = (id: string) => (contents[id] ??= []);
  const projectBlock = (call: FakeCall): MemoryBlock | FakeReply => {
    const block = blocks.find((candidate) => candidate.id === blockIdOf(call));
    if (!block) return failure(404, 'PROFILE_NOT_FOUND', 'Memory block not found');
    if (block.scope.kind !== 'project') return failure(400, 'BLOCK_NOT_PROJECT_SCOPE', 'Only a project memory block has content per folder');
    return block;
  };
  const contentsRoute = (call: FakeCall, run: (id: string, directory: string) => FakeReply): FakeReply => {
    const block = projectBlock(call);
    if (!('id' in block)) return block;
    const directory = query(call).get('directory') ?? (call.body?.directory as string | undefined);
    if (!directory) return failure(400, 'INVALID_PROFILE_INPUT', 'directory is required');
    return run(block.id, directory);
  };
  const noContent = () => failure(404, 'PROFILE_NOT_FOUND', 'No content for this folder');
  const routes: Record<string, FakeHandler> = {
    'GET /api/agent-profiles/memory-blocks': () => reply({ blocks: [...blocks].sort((a, b) => a.name.localeCompare(b.name)) }),
    'POST /api/agent-profiles/memory-blocks': (call) => {
      const body = call.body as unknown as MemoryBlockInput;
      if (blocks.some((block) => block.name === body.name)) return failure(409, 'BLOCK_NAME_TAKEN', 'taken');
      const content = body.scope.kind === 'project' ? '' : body.content ?? '';
      const block = makeMemoryBlock({ ...body, content, id: `b-${nextId++}`, lastWriter: content ? 'user' : null });
      blocks.push(block);
      return reply({ block }, 201);
    },
    'PUT /api/agent-profiles/memory-blocks/:id': (call) => {
      const id = call.path.split('/').pop();
      const body = call.body as unknown as MemoryBlockInput & { expectedRev: number };
      const index = blocks.findIndex((block) => block.id === id);
      if (index < 0) return failure(404, 'PROFILE_NOT_FOUND', 'Memory block not found');
      if (body.scope.kind !== blocks[index].scope.kind) return failure(409, 'BLOCK_SCOPE_IMMUTABLE', 'The scope of a memory block cannot be changed');
      if (body.name !== blocks[index].name && blocks.some((block) => block.name === body.name)) return failure(409, 'BLOCK_NAME_TAKEN', 'taken');
      if (blocks[index].rev !== body.expectedRev) return failure(409, 'PROFILE_STALE', 'stale', { currentRev: blocks[index].rev });
      const { expectedRev: _ignored, content, ...fields } = body;
      const isProject = blocks[index].scope.kind === 'project';
      blocks[index] = {
        ...blocks[index],
        ...fields,
        content: isProject ? '' : content ?? blocks[index].content,
        rev: blocks[index].rev + 1,
        lastWriter: !isProject && content !== blocks[index].content ? 'user' : blocks[index].lastWriter,
      };
      return reply({ block: blocks[index] });
    },
    'DELETE /api/agent-profiles/memory-blocks/:id': (call) => {
      const index = blocks.findIndex((block) => block.id === call.path.split('/').pop());
      if (index < 0) return failure(404, 'PROFILE_NOT_FOUND', 'Memory block not found');
      delete contents[blocks[index].id];
      blocks.splice(index, 1);
      return reply({ ok: true });
    },
    'GET /api/agent-profiles/memory-blocks/:id/contents': (call) => {
      const block = projectBlock(call);
      if (!('id' in block)) return block;
      return reply({ contents: [...files(block.id)].sort((a, b) => a.directory.localeCompare(b.directory)), corrupt: [] });
    },
    'POST /api/agent-profiles/memory-blocks/:id/contents': (call) => contentsRoute(call, (id, directory) => {
      if (files(id).some((file) => file.directory === directory)) return failure(409, 'BLOCK_CONTENT_EXISTS', 'This folder already has content for the memory block');
      const created = makeProjectContent({ directory, rev: (tombs.get(`${id}|${directory}`) ?? 0) + 1 });
      files(id).push(created);
      return reply({ content: created }, 201);
    }),
    'PUT /api/agent-profiles/memory-blocks/:id/contents': (call) => contentsRoute(call, (id, directory) => {
      const index = files(id).findIndex((file) => file.directory === directory);
      if (index < 0) return noContent();
      const body = call.body as { content: string; expectedRev: number };
      if (files(id)[index].rev !== body.expectedRev) return failure(409, 'PROFILE_STALE', 'stale', { currentRev: files(id)[index].rev });
      files(id)[index] = { ...files(id)[index], content: body.content, rev: body.expectedRev + 1, lastWriter: 'user' };
      return reply({ content: files(id)[index] });
    }),
    'DELETE /api/agent-profiles/memory-blocks/:id/contents': (call) => contentsRoute(call, (id, directory) => {
      const index = files(id).findIndex((file) => file.directory === directory);
      if (index < 0) return noContent();
      const expected = query(call).get('expectedRev');
      if (expected !== null && Number(expected) !== files(id)[index].rev) return failure(409, 'PROFILE_STALE', 'stale', { currentRev: files(id)[index].rev });
      if (query(call).get('remove') === 'true') {
        tombs.set(`${id}|${directory}`, files(id)[index].rev);
        files(id).splice(index, 1);
        return reply({ ok: true });
      }
      files(id)[index] = { ...files(id)[index], content: '', rev: files(id)[index].rev + 1, lastWriter: 'user' };
      return reply({ content: files(id)[index] });
    }),
  };
  return { blocks, contents, routes };
};

/** The `GET /claude-agents` answer for a list of entries. */
export const listing = (items: ClaudeAgentEntry[], overrides: Record<string, unknown> = {}) => ({
  items,
  hiddenNames: items.filter((item) => item.hidden).map((item) => item.name),
  hiddenRev: 1,
  builtinSource: 'sdk',
  ...overrides,
});
