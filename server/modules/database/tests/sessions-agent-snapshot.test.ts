import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Database,
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { PROJECTS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import type { SessionAgentSnapshot } from '@/shared/types.js';

const SNAPSHOT: SessionAgentSnapshot = { agentName: 'orchestrator', hiddenClaudeAgents: ['Explore'] };

async function withTemporaryDatabase(
  prepare: ((databasePath: string) => void) | null,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-agent-snapshot-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  prepare?.(databasePath);
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const sessionColumns = (): string[] =>
  (getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((column) => column.name);

test('a new database has the agent scope and snapshot columns, empty for plain sessions', async () => {
  await withTemporaryDatabase(null, () => {
    assert.ok(sessionColumns().includes('agent_scope_project_id'));
    assert.ok(sessionColumns().includes('agent_profile_snapshot'));

    sessionsDb.createAppSession('plain-1', 'claude', '/workspace/plain', 'Plain');
    assert.equal(sessionsDb.getAgentSnapshot('plain-1'), null);
    assert.equal(sessionsDb.getAgentSnapshot('no-such-session'), null);
  });
});

test('a scoped app session stores its agent record with the row and reads it back identically', async () => {
  await withTemporaryDatabase(null, () => {
    sessionsDb.createAppSession('scoped-1', 'claude', '/workspace/alpha', 'Scoped', SNAPSHOT);

    const stored = getConnection()
      .prepare('SELECT agent_scope_project_id, agent_profile_snapshot FROM sessions WHERE session_id = ?')
      .get('scoped-1') as { agent_scope_project_id: string | null; agent_profile_snapshot: string };
    assert.equal(stored.agent_scope_project_id, null, 'the old project-id column is no longer written');
    assert.equal(stored.agent_profile_snapshot, JSON.stringify(SNAPSHOT));
    assert.deepEqual(sessionsDb.getAgentSnapshot('scoped-1'), SNAPSHOT);
    // Same string every read: the main agent name a resume passes again is exactly the one stored.
    assert.equal(JSON.stringify(sessionsDb.getAgentSnapshot('scoped-1')), JSON.stringify(SNAPSHOT));

    // A scoped session without a main agent still keeps its hide list.
    const noAgent: SessionAgentSnapshot = { agentName: null, hiddenClaudeAgents: ['Plan'] };
    sessionsDb.createAppSession('scoped-2', 'claude', '/workspace/alpha', 'No agent', noAgent);
    assert.deepEqual(sessionsDb.getAgentSnapshot('scoped-2'), noAgent);
  });
});

test('session rows and listings never carry the snapshot', async () => {
  await withTemporaryDatabase(null, () => {
    sessionsDb.createAppSession('scoped-3', 'claude', '/workspace/alpha', 'Scoped', SNAPSHOT);

    const row = sessionsDb.getSessionById('scoped-3') as Record<string, unknown>;
    assert.ok(!('agent_profile_snapshot' in row));
    assert.ok(!JSON.stringify(sessionsDb.getAllSessions()).includes('hiddenClaudeAgents'));
  });
});

test('an unreadable stored snapshot throws instead of passing as a plain chat', async () => {
  await withTemporaryDatabase(null, () => {
    sessionsDb.createAppSession('broken-1', 'claude', '/workspace/alpha', 'Broken', SNAPSHOT);
    const corrupt = (value: string) => getConnection()
      .prepare('UPDATE sessions SET agent_profile_snapshot = ? WHERE session_id = ?').run(value, 'broken-1');
    const unreadable = (error: { code?: string }) => error.code === 'AGENT_SNAPSHOT_INVALID';

    corrupt('{not json');
    assert.throws(() => sessionsDb.getAgentSnapshot('broken-1'), unreadable);
    corrupt('{"promptVersion":1}');
    assert.throws(() => sessionsDb.getAgentSnapshot('broken-1'), unreadable);
    corrupt(JSON.stringify({ agentName: 5, hiddenClaudeAgents: [] }));
    assert.throws(() => sessionsDb.getAgentSnapshot('broken-1'), unreadable);
    corrupt(JSON.stringify({ agentName: 'x', hiddenClaudeAgents: 'Explore' }));
    assert.throws(() => sessionsDb.getAgentSnapshot('broken-1'), unreadable);
    corrupt(JSON.stringify({ agentName: 'x', hiddenClaudeAgents: [1] }));
    assert.throws(() => sessionsDb.getAgentSnapshot('broken-1'), unreadable);
  });
});

test('a row written before agents became files (orchestratorName + agents) still reads: no forced agent, hide list kept', async () => {
  await withTemporaryDatabase(null, () => {
    sessionsDb.createAppSession('old-scoped', 'claude', '/workspace/alpha', 'Old');
    const legacy = {
      promptVersion: 2,
      scope: { projectId: 'proj-1' },
      orchestratorName: 'orchestrator',
      agents: { orchestrator: { description: 'Main', prompt: 'Orchestrate.' } },
      memory: { applied: [], dropped: [] },
      hiddenClaudeAgents: ['Explore'],
    };
    getConnection()
      .prepare('UPDATE sessions SET agent_scope_project_id = ?, agent_profile_snapshot = ? WHERE session_id = ?')
      .run('proj-1', JSON.stringify(legacy), 'old-scoped');
    assert.deepEqual(sessionsDb.getAgentSnapshot('old-scoped'), { agentName: null, hiddenClaudeAgents: ['Explore'] });
  });
});

test('a fork of a scoped session keeps its agent record (and an old project id column); a fork of a plain session stays plain', async () => {
  await withTemporaryDatabase(null, () => {
    sessionsDb.createAppSession('source-scoped', 'claude', '/workspace/alpha', 'Scoped', SNAPSHOT);
    sessionsDb.createAppSession('source-plain', 'claude', '/workspace/alpha', 'Plain');
    // A row from before the column stopped being written still carries its project id into the fork.
    getConnection().prepare("UPDATE sessions SET agent_scope_project_id = 'proj-1' WHERE session_id = 'source-scoped'").run();
    const fork = (sessionId: string, fromId: string, providerId: string) => sessionsDb.createForkedSession({
      sessionId, provider: 'claude', projectPath: '/workspace/alpha', customName: 'Fork', providerSessionId: providerId,
      jsonlPath: `/fake/${providerId}.jsonl`, forkedFromSessionId: fromId, model: null, effort: null,
    });
    fork('fork-scoped', 'source-scoped', 'native-fork-1');
    fork('fork-plain', 'source-plain', 'native-fork-2');

    const columns = (sessionId: string) => getConnection()
      .prepare('SELECT agent_scope_project_id, agent_profile_snapshot FROM sessions WHERE session_id = ?')
      .get(sessionId) as { agent_scope_project_id: string | null; agent_profile_snapshot: string | null };
    assert.deepEqual(columns('fork-scoped'), columns('source-scoped'), 'byte-identical copy');
    assert.equal(columns('fork-scoped').agent_scope_project_id, 'proj-1');
    assert.deepEqual(sessionsDb.getAgentSnapshot('fork-scoped'), SNAPSHOT);
    assert.deepEqual(columns('fork-plain'), { agent_scope_project_id: null, agent_profile_snapshot: null });
  });
});

test('migrations add both columns to a database from before them, keep old sessions plain, and are idempotent', async () => {
  const prepareLegacyDatabase = (databasePath: string) => {
    // The sessions table as it shipped before the agent columns: a project and one session.
    const legacy = new Database(databasePath);
    legacy.exec(PROJECTS_TABLE_SCHEMA_SQL);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        model TEXT,
        effort TEXT,
        forked_from_session_id TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path) ON DELETE SET NULL ON UPDATE CASCADE
      );
    `);
    legacy.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('old-project', '/workspace/old');
    legacy.prepare("INSERT INTO sessions (session_id, provider, project_path, custom_name) VALUES ('old-session', 'claude', '/workspace/old', 'Old chat')").run();
    legacy.close();
  };

  await withTemporaryDatabase(prepareLegacyDatabase, () => {
    assert.ok(sessionColumns().includes('agent_scope_project_id'));
    assert.ok(sessionColumns().includes('agent_profile_snapshot'));
    assert.equal(sessionsDb.getSessionById('old-session')?.custom_name, 'Old chat');
    assert.equal(sessionsDb.getAgentSnapshot('old-session'), null);

    const before = sessionColumns();
    runMigrations(getConnection());
    runMigrations(getConnection());
    assert.deepEqual(sessionColumns(), before, 'running the migrations again changes nothing');
    assert.equal(sessionsDb.getSessionById('old-session')?.custom_name, 'Old chat');

    sessionsDb.createAppSession('new-scoped', 'claude', '/workspace/old', 'New', SNAPSHOT);
    assert.deepEqual(sessionsDb.getAgentSnapshot('new-scoped'), SNAPSHOT);
  });
});
