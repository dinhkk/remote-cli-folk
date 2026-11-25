import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * The scope-options route wired the way the server wires it: the real agent-profiles module resolving a
 * sidebar project id through the real `projectsDb` (isolated SQLite file), the user agents folder moved to
 * a temp home. Proves the id the sidebar knows (`project_id`) is the one the route takes, and that the folder
 * never travels back.
 */
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'scope-options-it-'));
const fakeHome = path.join(dataRoot, 'home');
mkdirSync(fakeHome, { recursive: true });
process.env.AGENT_PROFILES_DIR = path.join(dataRoot, 'agent-profiles');

// The module computes `~/.claude` when it is first imported, so the home is faked first and restored right after.
const realHomedir = os.homedir;
(os as { homedir: () => string }).homedir = () => fakeHome;
const { agentProfilesRoutes } = await import('@/modules/agent-profiles/index.js');
(os as { homedir: () => string }).homedir = realHomedir;

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const writeAgent = (agentsDirectory: string, name: string): void => {
  mkdirSync(agentsDirectory, { recursive: true });
  writeFileSync(path.join(agentsDirectory, `${name}.md`), `---\nname: ${name}\ndescription: PRIVATE-DESCRIPTION\n---\nPRIVATE-PROMPT\n`);
};

async function withServer(run: (get: (url: string) => Promise<{ status: number; body: any }>, scratch: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'scope-options-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/agent-profiles', agentProfilesRoutes);
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
    const get = async (url: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-profiles${url}`);
      return { status: response.status, body: await response.json() };
    };
    await run(get, scratch);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(scratch, { recursive: true, force: true });
  }
}

test('scope-options resolves the sidebar project id (projects.project_id) server-side and answers names only', async () => {
  await withServer(async (get, scratch) => {
    const folder = path.join(scratch, 'beta');
    mkdirSync(folder, { recursive: true });
    writeAgent(path.join(folder, '.claude', 'agents'), 'orchestrator');
    writeAgent(path.join(folder, '.claude', 'agents'), 'review-code');
    writeAgent(path.join(fakeHome, '.claude', 'agents'), 'global-helper');
    const created = projectsDb.createProjectPath(folder, 'Beta');
    assert.ok(created.project);

    const answer = await get(`/scope-options?projectId=${encodeURIComponent(created.project.project_id)}`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      agents: [
        { name: 'orchestrator', source: 'project', isOrchestrator: true },
        { name: 'review-code', source: 'project', isOrchestrator: false },
        { name: 'global-helper', source: 'user', isOrchestrator: false },
      ],
    });
    const raw = JSON.stringify(answer.body);
    for (const leaked of ['PRIVATE', 'beta', 'scope-options-', 'home', '.claude']) assert.ok(!raw.includes(leaked), `answer must not contain "${leaked}"`);

    // Not the folder, not a name: only the id resolves.
    assert.equal((await get(`/scope-options?projectId=${encodeURIComponent(folder)}`)).status, 404);
    assert.equal((await get('/scope-options?projectId=Beta')).status, 404);
    const unknown = await get('/scope-options?projectId=00000000-0000-4000-8000-000000000000');
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'PROJECT_NOT_FOUND']);
    assert.ok(!JSON.stringify(unknown.body).includes('scope-options-'));
    assert.equal((await get('/scope-options')).status, 400);
  });
});
