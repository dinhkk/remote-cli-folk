import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Seeding goes through the real store and service on purpose: the agent-profiles barrel exports no test-only helpers.
// oxlint-disable-next-line boundaries/dependencies
import { createBlocksService } from '@/modules/agent-profiles/agent-profiles.blocks.service.js';
// oxlint-disable-next-line boundaries/dependencies
import { blockContentKey, createAgentProfileStore } from '@/modules/agent-profiles/agent-profiles.store.js';
// oxlint-disable-next-line boundaries/dependencies
import { storedShapeProblem } from '@/modules/agent-profiles/agent-profiles.validation.js';
import type { AnyRecord, SessionAgentSnapshot } from '@/shared/types.js';

// The agent-profiles module reads its data directory when it is first imported (on the first call below), so
// the environment is prepared before any run is built.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-blocks-mcp-'));
const profilesRoot = path.join(dataRoot, 'agent-profiles');
process.env.AGENT_PROFILES_DIR = profilesRoot;
const { resolveBlocksAgentName, withBlocksMcpServer, withBlocksToolsAllowed } = await import('@/modules/providers/list/claude/claude-blocks-mcp.js');

test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

const PROJECT_A = path.resolve(path.sep, 'work', 'project-a');
const PROJECT_B = path.resolve(path.sep, 'work', 'project-b');
/** A folder that owns no project block; only the global block is visible there. */
const PROJECT_C = path.resolve(path.sep, 'work', 'project-c');
const scoped: SessionAgentSnapshot = { agentName: 'orchestrator', hiddenClaudeAgents: [] };
const MAIN_AGENT = 'orchestrator';

/** Seeds through the real service on the same store directory the run's module reads (the way the REST routes write). */
const seedStore = createAgentProfileStore({ rootDir: profilesRoot, checkShape: storedShapeProblem });
const seeder = createBlocksService({ store: seedStore });

function seedGlobal(name: string, content: string, mode = 'read-only'): string {
  return seeder.create({ name, description: '', mode, scope: { kind: 'global' }, content, maxChars: 2000 }).block.id;
}

/** A project block with a content file (holding `content`) in each of `directories`; an empty `content` leaves the files empty. */
function seedProject(name: string, directories: string[], content = ''): string {
  const { id } = seeder.create({ name, description: '', mode: 'writable', scope: { kind: 'project' }, maxChars: 2000 }).block;
  for (const directory of directories) {
    const { content: created } = seeder.addContent(id, directory);
    if (content) seeder.updateContent(id, directory, content, created.rev);
  }
  return id;
}

/** The stored content file of a block in a folder. */
const contentFile = (id: string, directory: string) => seedStore.getContent(id, blockContentKey(directory));

const globalId = seedGlobal('shared', 'GLOBAL-TEXT');
const aId = seedProject('a-notes', [PROJECT_A], 'A-TEXT');
const bId = seedProject('b-notes', [PROJECT_B], 'B-TEXT');
// A definition with no content file anywhere: invisible everywhere, so it must not attach or leak.
seedProject('unplaced-notes', []);

type BlocksServer = { type: string; name: string; instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> } };

/** The `blocks` server a run of this session in `cwd` would get (a fresh one per call, like a fresh run). */
async function blocksOfRun(blocksAgentName: string, cwd: string): Promise<BlocksServer> {
  const servers = await withBlocksMcpServer(null, blocksAgentName, cwd);
  assert.ok(servers?.blocks, 'the run got a blocks server');
  return servers.blocks as BlocksServer;
}

/** One tool call over the real MCP protocol (in-memory transport), on a server of one run. */
async function callTool(server: BlocksServer, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((part) => part.text).join('\n'), isError: result.isError === true };
  } finally {
    await client.close().catch(() => undefined);
    await server.instance.close().catch(() => undefined);
  }
}

test('a session with a main agent gets the `blocks` server, merged into the configured MCP servers (nothing overwritten)', async () => {
  const configured: AnyRecord = { docs: { type: 'stdio', command: 'docs-mcp' }, 'browser-use': { type: 'http', url: 'http://127.0.0.1:1/mcp' } };
  const merged = await withBlocksMcpServer(configured, MAIN_AGENT, PROJECT_A);
  assert.ok(merged);
  assert.deepEqual(Object.keys(merged).sort(), ['blocks', 'browser-use', 'docs']);
  assert.equal(merged.docs, configured.docs, 'the configured servers are kept as they are');
  assert.equal(merged['browser-use'], configured['browser-use']);
  assert.equal(merged.blocks.type, 'sdk');
  assert.equal(merged.blocks.name, 'blocks');
  assert.deepEqual(Object.keys(configured).sort(), ['browser-use', 'docs'], 'the loaded config object itself is not mutated');
});

test('a session with a main agent and no configured servers still gets `blocks`', async () => {
  const merged = await withBlocksMcpServer(null, MAIN_AGENT, PROJECT_A);
  assert.deepEqual(Object.keys(merged ?? {}), ['blocks']);
});

test('a run without a blocks agent name gets no `blocks`; the configured servers pass through untouched', async () => {
  const configured: AnyRecord = { docs: { type: 'stdio', command: 'docs-mcp' } };
  assert.equal(await withBlocksMcpServer(configured, undefined, PROJECT_A), configured);
  assert.equal(await withBlocksMcpServer(null, undefined, PROJECT_A), null);
  assert.equal(await withBlocksMcpServer(null, '', PROJECT_A), null);
});

test('a configured server named `blocks` is replaced by the app\'s own', async () => {
  const configured: AnyRecord = { blocks: { type: 'stdio', command: 'someone-elses' }, docs: { type: 'stdio', command: 'docs-mcp' } };
  const merged = await withBlocksMcpServer(configured, 'claude-code', PROJECT_A);
  assert.equal(merged?.blocks.type, 'sdk');
  assert.equal(merged?.docs, configured.docs);
});

test('every run builds its own server (a resumed run attaches it again; the session never remembers it)', async () => {
  const first = await blocksOfRun(MAIN_AGENT, PROJECT_A);
  const resumed = await blocksOfRun(MAIN_AGENT, PROJECT_A);
  assert.notEqual(first, resumed);
});

test('a session with a main agent resolves to that agent, whatever the folder holds', async () => {
  assert.equal(await resolveBlocksAgentName(scoped, PROJECT_A), 'orchestrator');
  assert.equal(await resolveBlocksAgentName(scoped, PROJECT_C), 'orchestrator', 'no project block needed when there is a main agent');
  assert.equal(await resolveBlocksAgentName(scoped, undefined), 'orchestrator');
});

test('plain chat in a folder with a project block resolves to claude-code, also for a scoped session with no main agent', async () => {
  assert.equal(await resolveBlocksAgentName(undefined, PROJECT_A), 'claude-code');
  const noAgent: SessionAgentSnapshot = { agentName: null, hiddenClaudeAgents: ['Explore'] };
  assert.equal(await resolveBlocksAgentName(noAgent, PROJECT_A), 'claude-code');
  assert.equal(await resolveBlocksAgentName({ agentName: '', hiddenClaudeAgents: [] }, PROJECT_B), 'claude-code');
  // The attach hooks agree: a server and the read tools for that run.
  const merged = await withBlocksMcpServer(null, 'claude-code', PROJECT_A);
  assert.deepEqual(Object.keys(merged ?? {}), ['blocks']);
  assert.deepEqual(withBlocksToolsAllowed([], 'claude-code'), ['mcp__blocks__block_list', 'mcp__blocks__block_read']);
});

test('plain chat gets no blocks where only a global block exists, in another project\'s folder, in a subfolder, or with no folder', async () => {
  assert.equal(await resolveBlocksAgentName(undefined, PROJECT_C), undefined, 'a global block alone does not attach the server');
  assert.equal(await resolveBlocksAgentName(undefined, path.join(PROJECT_A, 'src')), undefined, 'exact folder only: a subfolder or worktree does not count');
  assert.equal(await resolveBlocksAgentName(undefined, path.resolve(path.sep, 'work', 'project-a-copy')), undefined);
  assert.equal(await resolveBlocksAgentName(undefined, undefined), undefined);
  assert.equal(await resolveBlocksAgentName(undefined, ''), undefined);
  const configured: AnyRecord = { docs: { type: 'stdio', command: 'docs-mcp' } };
  const none = await resolveBlocksAgentName(undefined, PROJECT_C);
  assert.equal(await withBlocksMcpServer(configured, none, PROJECT_C), configured);
  assert.deepEqual(withBlocksToolsAllowed(['Read'], none), ['Read']);
});

test('the attached server serves the run\'s project and the global blocks, and nothing of another project', async () => {
  const list = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_A), 'block_list', {});
  assert.match(list.text, /name="shared"/);
  assert.match(list.text, /name="a-notes"/);
  assert.ok(!list.text.includes('b-notes'), 'project B\'s block is not listed in a run of project A');

  const readGlobal = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_A), 'block_read', { name: 'shared' });
  assert.equal(readGlobal.text, '<block name="shared" mode="read-only" writer="user" rev="1">GLOBAL-TEXT</block>');
  const readOther = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_A), 'block_read', { name: 'b-notes' });
  assert.equal(readOther.isError, true);
  assert.ok(!readOther.text.includes('B-TEXT'));
  const readOwnInB = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_B), 'block_read', { name: 'b-notes' });
  assert.match(readOwnInB.text, /B-TEXT/);
});

test('the attached server enforces read-only and records the session\'s main agent as the writer', async () => {
  const denied = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_A), 'block_write', { name: 'shared', content: 'HACKED', how: 'replace' });
  assert.equal(denied.isError, true);
  assert.equal(seedStore.get<{ content: string }>('memory-blocks', globalId)?.content, 'GLOBAL-TEXT');

  const written = await callTool(await blocksOfRun('lead', PROJECT_A), 'block_write', { name: 'a-notes', content: 'new line', how: 'append' });
  assert.equal(written.isError, false);
  const stored = contentFile(aId, PROJECT_A);
  assert.equal(stored?.content, 'A-TEXT\nnew line');
  assert.equal(stored?.lastWriter, 'agent:lead');
  assert.equal(contentFile(bId, PROJECT_B)?.content, 'B-TEXT', 'the same block in another folder is untouched');
});

test('a plain chat\'s server serves the folder\'s project block and records agent:claude-code as the writer; read-only still holds', async () => {
  const plain = await resolveBlocksAgentName(undefined, PROJECT_B);
  assert.equal(plain, 'claude-code');
  const readOwn = await callTool(await blocksOfRun(plain as string, PROJECT_B), 'block_read', { name: 'b-notes' });
  assert.match(readOwn.text, /B-TEXT/);
  const denied = await callTool(await blocksOfRun('claude-code', PROJECT_B), 'block_write', { name: 'shared', content: 'HACKED', how: 'replace' });
  assert.equal(denied.isError, true, 'a read-only global block stays read-only for plain chat');
  const written = await callTool(await blocksOfRun('claude-code', PROJECT_B), 'block_write', { name: 'b-notes', content: 'from plain chat', how: 'append' });
  assert.equal(written.isError, false);
  const stored = contentFile(bId, PROJECT_B);
  assert.equal(stored?.content, 'B-TEXT\nfrom plain chat');
  assert.equal(stored?.lastWriter, 'agent:claude-code');
});

test('only block_list and block_read are pre-approved, only for a run with the server; block_write is left to the approval flow', () => {
  const base = ['Read', 'mcp__blocks__block_read'];
  const allowed = withBlocksToolsAllowed(base, MAIN_AGENT);
  assert.deepEqual(allowed, ['Read', 'mcp__blocks__block_read', 'mcp__blocks__block_list']);
  assert.ok(!allowed.includes('mcp__blocks__block_write'), 'block_write is not pre-approved');
  assert.ok(!withBlocksToolsAllowed([], MAIN_AGENT).includes('mcp__blocks__block_write'));
  assert.deepEqual(withBlocksToolsAllowed([], MAIN_AGENT), ['mcp__blocks__block_list', 'mcp__blocks__block_read']);
  // A user who allowed block_write themselves keeps it: the list is only added to, never trimmed.
  assert.ok(withBlocksToolsAllowed(['mcp__blocks__block_write'], MAIN_AGENT).includes('mcp__blocks__block_write'));
  assert.deepEqual(base, ['Read', 'mcp__blocks__block_read'], 'the input list is not mutated');
  assert.equal(withBlocksToolsAllowed(base, undefined), base);
  assert.equal(withBlocksToolsAllowed(base, ''), base);
});

test('the Claude runtime resolves the blocks agent and attaches the server on every run, after the configured servers are loaded', () => {
  const source = fs.readFileSync(new URL('../list/claude/claude-runtime.provider.ts', import.meta.url), 'utf8');
  assert.match(source, /const blocksAgentName = await resolveBlocksAgentName\(\s*options\.agentProfile as SessionAgentSnapshot \| undefined,\s*options\.cwd,?\s*\)/);
  assert.match(source, /await withBlocksMcpServer\(\s*await loadMcpConfig\(options\.cwd\),\s*blocksAgentName,\s*options\.cwd,?\s*\)/);
  assert.match(source, /withBlocksToolsAllowed\(\s*sdkOptions\.allowedTools \|\| \[\],\s*blocksAgentName,?\s*\)/);
  assert.equal(source.match(/sdkOptions\.mcpServers\s*=/g)?.length, 1, 'one place sets the servers, so no run path can skip the merge');
});

test('one project block with a content file in two folders: each run reads and writes its own file, neither sees the other', async () => {
  const shared = seedProject('twin-notes', [PROJECT_A, PROJECT_B], 'TWIN-SEED');
  await callTool(await blocksOfRun('claude-code', PROJECT_A), 'block_write', { name: 'twin-notes', content: 'only-in-a', how: 'replace' });
  assert.equal(contentFile(shared, PROJECT_A)?.content, 'only-in-a');
  assert.equal(contentFile(shared, PROJECT_B)?.content, 'TWIN-SEED');
  const readInB = await callTool(await blocksOfRun('claude-code', PROJECT_B), 'block_read', { name: 'twin-notes' });
  assert.match(readInB.text, /TWIN-SEED/);
  assert.ok(!readInB.text.includes('only-in-a'));
});

test('a definition without a content file in the folder is invisible there (list and read), also for a main agent', async () => {
  const listInC = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_C), 'block_list', {});
  assert.match(listInC.text, /name="shared"/);
  for (const hidden of ['a-notes', 'b-notes', 'unplaced-notes']) assert.ok(!listInC.text.includes(hidden), `${hidden} is not listed`);
  const read = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_C), 'block_read', { name: 'a-notes' });
  assert.equal(read.isError, true);
  assert.ok(!read.text.includes('A-TEXT'));
  const write = await callTool(await blocksOfRun(MAIN_AGENT, PROJECT_C), 'block_write', { name: 'unplaced-notes', content: 'x', how: 'replace' });
  assert.equal(write.isError, true, 'an agent cannot create a content file by writing');
  assert.equal(seedStore.listContents(seeder.list().blocks.find((block) => block.name === 'unplaced-notes')!.id).items.length, 0);
});

test('an empty content file attaches the server for plain chat, and stays attached after the text is emptied between turns', async () => {
  const folder = path.resolve(path.sep, 'work', 'project-empty');
  const id = seedProject('empty-notes', [folder]);
  assert.equal(await resolveBlocksAgentName(undefined, folder), 'claude-code');
  seeder.updateContent(id, folder, 'some text', contentFile(id, folder)!.rev);
  assert.equal(await resolveBlocksAgentName(undefined, folder), 'claude-code');
  seeder.emptyContent(id, folder);
  assert.equal(await resolveBlocksAgentName(undefined, folder), 'claude-code', 'the resumed run keeps its tools');
  const read = await callTool(await blocksOfRun('claude-code', folder), 'block_read', { name: 'empty-notes' });
  assert.equal(read.isError, false);
  assert.match(read.text, /<block name="empty-notes"[^>]*><\/block>/);
});

test('removing the last content file of a folder detaches the tool for plain chat, a main agent keeps it', async () => {
  const folder = path.resolve(path.sep, 'work', 'project-removed');
  const id = seedProject('removed-notes', [folder]);
  assert.equal(await resolveBlocksAgentName(undefined, folder), 'claude-code');
  seeder.removeFolder(id, folder);
  assert.equal(await resolveBlocksAgentName(undefined, folder), undefined);
  assert.equal(await resolveBlocksAgentName(scoped, folder), 'orchestrator');
  const list = await callTool(await blocksOfRun(MAIN_AGENT, folder), 'block_list', {});
  assert.ok(!list.text.includes('removed-notes'));
});

test('the folder is matched by its normalized key: a differently written path reaches the same content file', async () => {
  const folder = path.resolve(path.sep, 'work', 'project-key');
  seedProject('key-notes', [folder], 'KEY-TEXT');
  const messy = path.join(folder, 'sub', '..') + path.sep;
  assert.equal(await resolveBlocksAgentName(undefined, messy), 'claude-code');
  const read = await callTool(await blocksOfRun('claude-code', messy), 'block_read', { name: 'key-notes' });
  assert.match(read.text, /KEY-TEXT/);
});

test('a corrupt content file hides only that block in that folder; the others still work', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const folder = path.resolve(path.sep, 'work', 'project-corrupt');
    const goodId = seedProject('good-notes', [folder], 'GOOD');
    const badId = seedProject('bad-notes', [folder], 'BAD');
    const badDirectory = path.join(profilesRoot, 'memory-block-contents', badId);
    for (const file of fs.readdirSync(badDirectory)) fs.writeFileSync(path.join(badDirectory, file), '{ not json');
    assert.equal(await resolveBlocksAgentName(undefined, folder), 'claude-code', 'the readable block still attaches the server');
    const list = await callTool(await blocksOfRun('claude-code', folder), 'block_list', {});
    assert.match(list.text, /name="good-notes"/);
    assert.ok(!list.text.includes('bad-notes'));
    const good = await callTool(await blocksOfRun('claude-code', folder), 'block_read', { name: 'good-notes' });
    assert.match(good.text, /GOOD/);
    assert.equal(contentFile(goodId, folder)?.content, 'GOOD');
  } finally {
    warn.mock.restore();
  }
});

// Last on purpose: it breaks the block store (a file where the folder should be) to prove a read error never fails a run.
test('a store read error is logged and the run goes on without the blocks server', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const blocksDirectory = path.join(profilesRoot, 'memory-blocks');
    fs.rmSync(blocksDirectory, { recursive: true, force: true });
    fs.writeFileSync(blocksDirectory, 'not a folder');
    assert.equal(await resolveBlocksAgentName(undefined, PROJECT_A), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(await resolveBlocksAgentName(scoped, PROJECT_A), 'orchestrator', 'a main agent never needs the store to resolve');
  } finally {
    warn.mock.restore();
  }
});
