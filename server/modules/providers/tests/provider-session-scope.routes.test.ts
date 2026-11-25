import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

// The agent-profiles module reads its data directory when it is first imported, so the
// environment is prepared first and the router (which imports that module) loaded after.
// A CLAUDE_CLI_PATH that cannot start makes the built-in Claude agent lookup fail at once
// and fall back to its static list: no CLI process, no model.
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'session-scope-routes-'));
process.env.AGENT_PROFILES_DIR = path.join(dataRoot, 'agent-profiles');
process.env.CLAUDE_CLI_PATH = path.join(dataRoot, 'no-such-claude.exe');
const { default: providerRouter } = await import('@/modules/providers/provider.routes.js');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

async function withProviderServer(
  run: (post: (body: Record<string, unknown>) => Promise<{ status: number; body: any }>, scratch: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-scope-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address() as AddressInfo;
    const post = async (body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/providers/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    await run(post, tempDirectory);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const realDirectory = (scratch: string, name: string): string => {
  const directory = path.join(scratch, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

test('a body without scope is a plain chat: the client projectPath is used and no snapshot is stored', async () => {
  await withProviderServer(async (post, scratch) => {
    const clientPath = realDirectory(scratch, 'plain-project');
    const response = await post({ provider: 'claude', projectPath: clientPath, initialMessage: 'hello there' });

    assert.equal(response.status, 201);
    assert.equal(path.resolve(response.body.data.projectPath), path.resolve(clientPath));
    assert.equal(sessionsDb.getAgentSnapshot(response.body.data.sessionId), null);
  });
});

/** Writes `<directory>/.claude/agents/<name>.md`, the native agent file a scoped session runs as. */
function writeAgentFile(directory: string, name: string): void {
  const folder = path.join(directory, '.claude', 'agents');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`);
}

test('a scope with any provider other than claude is refused clearly and creates nothing', async () => {
  await withProviderServer(async (post, scratch) => {
    for (const provider of ['codex', 'cursor', 'opencode']) {
      const response = await post({ provider, projectPath: realDirectory(scratch, 'p'), scope: { agentName: null } });
      assert.equal(response.status, 400, provider);
      assert.equal(response.body.error.code, 'SCOPE_UNSUPPORTED_PROVIDER');
    }
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('a malformed scope is a 400, never silently a plain chat', async () => {
  await withProviderServer(async (post, scratch) => {
    for (const scope of [null, 'p1', 7, [], {}, { agentName: 5 }, { agentName: '' }, { agentName: '  ' }, { agentname: 'x' }, { projectId: 'alpha' }, { projectId: null }]) {
      const response = await post({ provider: 'claude', projectPath: realDirectory(scratch, 'p'), scope });
      assert.equal(response.status, 400, JSON.stringify(scope));
      assert.equal(response.body.error.code, 'INVALID_SESSION_SCOPE');
    }
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('a scope needs the sidebar project folder: without projectPath it is a 400 and creates no session', async () => {
  await withProviderServer(async (post) => {
    for (const projectPath of [undefined, '', '   ']) {
      const response = await post({ provider: 'claude', projectPath, scope: { agentName: 'orchestrator' } });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'PROJECT_PATH_REQUIRED');
    }
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('an agent that is not a file is a 404, an invalid agent name a 400; neither creates a session', async () => {
  await withProviderServer(async (post, scratch) => {
    const projectPath = realDirectory(scratch, 'p');
    const unknown = await post({ provider: 'claude', projectPath, scope: { agentName: 'not-an-agent' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'AGENT_NOT_FOUND');
    const builtin = await post({ provider: 'claude', projectPath, scope: { agentName: 'Explore' } });
    assert.equal(builtin.status, 404, 'a built-in is not a main agent file');
    const invalid = await post({ provider: 'claude', projectPath, scope: { agentName: '../escape' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_AGENT_NAME');
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('a relative projectPath with a scope is a 400 and creates no session', async () => {
  await withProviderServer(async (post) => {
    const response = await post({ provider: 'claude', projectPath: path.join('relative', 'dir'), scope: { agentName: 'orchestrator' } });
    assert.equal(response.status, 400);
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('a scope opens the session in the sidebar project folder, registers it, and stores the main agent name', async () => {
  await withProviderServer(async (post, scratch) => {
    const projectDirectory = realDirectory(scratch, 'alpha');
    writeAgentFile(projectDirectory, 'orchestrator');

    const response = await post({ provider: 'claude', projectPath: projectDirectory, initialMessage: 'review MR 123', scope: { agentName: 'orchestrator' } });

    assert.equal(response.status, 201);
    const { sessionId, projectPath } = response.body.data;
    assert.equal(path.resolve(projectPath), path.resolve(projectDirectory));
    assert.equal(path.resolve(sessionsDb.getSessionById(sessionId)?.project_path ?? ''), path.resolve(projectDirectory));
    assert.ok(projectsDb.getProjectPath(sessionsDb.getSessionById(sessionId)?.project_path ?? ''), 'the directory is registered as a project');
    assert.deepEqual(sessionsDb.getAgentSnapshot(sessionId), { agentName: 'orchestrator', hiddenClaudeAgents: [] });
  });
});

test('an agent file of another project folder is not accepted for this project', async () => {
  await withProviderServer(async (post, scratch) => {
    writeAgentFile(realDirectory(scratch, 'beta'), 'orchestrator');
    const response = await post({ provider: 'claude', projectPath: realDirectory(scratch, 'alpha'), scope: { agentName: 'orchestrator' } });
    assert.equal(response.status, 404);
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('{ agentName: null } opens a scoped session without a main agent', async () => {
  await withProviderServer(async (post, scratch) => {
    const response = await post({ provider: 'claude', projectPath: realDirectory(scratch, 'alpha'), scope: { agentName: null } });
    assert.equal(response.status, 201);
    assert.deepEqual(sessionsDb.getAgentSnapshot(response.body.data.sessionId), { agentName: null, hiddenClaudeAgents: [] });
  });
});

