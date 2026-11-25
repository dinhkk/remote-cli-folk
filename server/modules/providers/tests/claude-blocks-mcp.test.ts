import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { AnyRecord, SessionAgentSnapshot } from '@/shared/types.js';

// The agent-profiles module reads its data directory when it is first imported (on the first call below), so
// the environment is prepared before any run is built.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-blocks-mcp-'));
const blocksDirectory = path.join(dataRoot, 'agent-profiles', 'memory-blocks');
process.env.AGENT_PROFILES_DIR = path.join(dataRoot, 'agent-profiles');
const { resolveBlocksAgentName, withBlocksMcpServer, withBlocksToolsAllowed } = await import('@/modules/providers/list/claude/claude-blocks-mcp.js');

test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

const PROJECT_A = path.resolve(path.sep, 'work', 'project-a');
const PROJECT_B = path.resolve(path.sep, 'work', 'project-b');
/** A folder that owns no project block; only the global block is visible there. */
const PROJECT_C = path.resolve(path.sep, 'work', 'project-c');
const scoped: SessionAgentSnapshot = { agentName: 'orchestrator', hiddenClaudeAgents: [] };
const MAIN_AGENT = 'orchestrator';

/** A block file in the real store format (what the REST routes write), so the run's server reads real data. */
function seedBlock(id: string, name: string, scope: AnyRecord, content: string, mode = 'writable'): void {
  fs.mkdirSync(blocksDirectory, { recursive: true });
  fs.writeFileSync(path.join(blocksDirectory, `${id}.json`), JSON.stringify({
    id, rev: 1, updatedAt: '2026-11-24T00:00:00.000Z', name, description: '', mode, scope, content, maxChars: 2000, lastWriter: 'user',
  }));
}

seedBlock('g1', 'shared', { kind: 'global' }, 'GLOBAL-TEXT', 'read-only');
seedBlock('a1', 'a-notes', { kind: 'project', directory: PROJECT_A }, 'A-TEXT');
seedBlock('b1', 'b-notes', { kind: 'project', directory: PROJECT_B }, 'B-TEXT');

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
  assert.equal(JSON.parse(fs.readFileSync(path.join(blocksDirectory, 'g1.json'), 'utf8')).content, 'GLOBAL-TEXT');

  const written = await callTool(await blocksOfRun('lead', PROJECT_A), 'block_write', { name: 'a-notes', content: 'new line', how: 'append' });
  assert.equal(written.isError, false);
  const stored = JSON.parse(fs.readFileSync(path.join(blocksDirectory, 'a1.json'), 'utf8'));
  assert.equal(stored.content, 'A-TEXT\nnew line');
  assert.equal(stored.lastWriter, 'agent:lead');
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
  const stored = JSON.parse(fs.readFileSync(path.join(blocksDirectory, 'b1.json'), 'utf8'));
  assert.equal(stored.content, 'B-TEXT\nfrom plain chat');
  assert.equal(stored.lastWriter, 'agent:claude-code');
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

// Last on purpose: it breaks the block store (a file where the folder should be) to prove a read error never fails a run.
test('a store read error is logged and the run goes on without the blocks server', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    fs.rmSync(blocksDirectory, { recursive: true, force: true });
    fs.writeFileSync(blocksDirectory, 'not a folder');
    assert.equal(await resolveBlocksAgentName(undefined, PROJECT_A), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(await resolveBlocksAgentName(scoped, PROJECT_A), 'orchestrator', 'a main agent never needs the store to resolve');
  } finally {
    warn.mock.restore();
  }
});
