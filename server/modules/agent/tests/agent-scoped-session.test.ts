import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { SessionAgentSnapshot } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { createAgentRouter } from '../agent.routes.js';

/**
 * `POST /api/agent` continues a session by calling the Claude runtime directly, not through the
 * chat gateway, so it has to hand over a scoped session's frozen agent snapshot itself.
 */

type AgentDependencies = Parameters<typeof createAgentRouter>[0];
type RunFunction = AgentDependencies['queryClaude'];

// A real absolute path of this OS: the route compares normalized paths, and a POSIX-style literal is not absolute on Windows.
const PROJECT_PATH = path.join(tmpdir(), 'agent-scoped-project');

const SNAPSHOT: SessionAgentSnapshot = { agentName: 'orchestrator', hiddenClaudeAgents: ['Explore'] };

async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-scoped-session-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await run();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Router dependencies wired like production's session gateway, snapshot reader included. */
function createDependencies(queryClaude: RunFunction): AgentDependencies {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  return {
    fileSystem: { access: async () => undefined } as unknown as AgentDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as AgentDependencies['spawnProcess'],
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    githubTokens: { getActiveGithubToken: () => null },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    models: { getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }) } as unknown as AgentDependencies['models'],
    sessions: {
      getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
      getSessionByProviderSessionId: (providerSessionId) => sessionsDb.getSessionByProviderSessionId(providerSessionId),
      createAppSession: (provider, projectPath, initialMessage) => {
        const sessionId = `app-${nodeCrypto.randomUUID()}`;
        sessionsDb.createAppSession(sessionId, provider, projectPath, initialMessage);
        return { sessionId };
      },
      getAgentSnapshot: (sessionId) => sessionsDb.getAgentSnapshot(sessionId),
    },
    runs: chatRunRegistry,
    queryClaude,
    queryCursor: unexpected as RunFunction,
    queryCodex: unexpected as RunFunction,
    queryOpenCode: unexpected as RunFunction,
    GithubClient: class {} as unknown as AgentDependencies['GithubClient'],
  };
}

/** Runtime stand-in that records the options of each run and completes at once. */
function createRecordingRuntime() {
  const optionsSeen: Array<Record<string, unknown>> = [];
  const queryClaude: RunFunction = async (_command, options, writer) => {
    optionsSeen.push(options as Record<string, unknown>);
    const announced = (writer as { getSessionId?: () => string | null }).getSessionId?.() ?? 'native-1';
    writer.send(createNormalizedMessage({ kind: 'session_created', provider: 'claude', sessionId: announced, newSessionId: announced }));
    writer.send(createNormalizedMessage({ kind: 'complete', provider: 'claude', sessionId: announced, exitCode: 0 }));
  };
  return { queryClaude, optionsSeen };
}

async function postAgent(dependencies: AgentDependencies, body: Record<string, unknown>): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/api/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: false, ...body }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('continuing a scoped session through the Agent API passes its stored agent record again', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-scoped', 'claude', PROJECT_PATH, 'Scoped', SNAPSHOT);
    sessionsDb.assignProviderSessionId('app-scoped', 'native-scoped');
    const runtime = createRecordingRuntime();

    const response = await postAgent(createDependencies(runtime.queryClaude), {
      projectPath: PROJECT_PATH, message: 'More', sessionId: 'app-scoped',
    });

    assert.equal(response.status, 200);
    assert.equal(runtime.optionsSeen.length, 1);
    assert.deepEqual(runtime.optionsSeen[0].agentProfile, SNAPSHOT);
    assert.equal(runtime.optionsSeen[0].cwd, runtime.optionsSeen[0].projectPath);
  });
});

test('an unscoped session and a brand-new API run carry no agentProfile key at all', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-plain', 'claude', PROJECT_PATH, 'Plain');
    sessionsDb.assignProviderSessionId('app-plain', 'native-plain');
    const runtime = createRecordingRuntime();

    await postAgent(createDependencies(runtime.queryClaude), { projectPath: PROJECT_PATH, message: 'Continue', sessionId: 'app-plain' });
    await postAgent(createDependencies(runtime.queryClaude), { projectPath: PROJECT_PATH, message: 'Fresh' });

    assert.equal(runtime.optionsSeen.length, 2);
    for (const options of runtime.optionsSeen) {
      assert.ok(!('agentProfile' in options));
    }
  });
});
