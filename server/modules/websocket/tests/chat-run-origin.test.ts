import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authenticateWebSocket, issueLoopbackToken } from '@/modules/auth/index.js';
import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.send = () => {};
  return socket;
}

type RunCall = { options: Record<string, unknown> };

async function withDatabase(runTest: (context: { runs: RunCall[]; runtime: never; projectPath: string }) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-run-origin-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const runs: RunCall[] = [];
  const runtime = {
    hasRuntime: () => true,
    run: async (_provider: string, _command: string, options: Record<string, unknown>) => {
      runs.push({ options });
    },
  } as never;
  try {
    await runTest({ runs, runtime, projectPath: path.join(tempDirectory, 'project') });
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

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

function connect(runtime: never, user: Record<string, unknown>) {
  const socket = createFakeSocket();
  handleChatConnection(socket as never, { user } as never, { runtime });
  return socket;
}

function send(socket: ReturnType<typeof createFakeSocket>, type: string, sessionId: string, extra: Record<string, unknown> = {}) {
  socket.emit('message', JSON.stringify({ type, sessionId, content: 'hello', ...extra }));
}

test('the upgrade marks a bridged connection as loopback and a browser session as session', async () => {
  await withDatabase(async () => {
    userDb.createUser('owner', 'hash');
    const token = issueLoopbackToken();
    const bridged = authenticateWebSocket({ headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(bridged?.authKind, 'loopback');
  });
});

test('a bridged chat runs as remote, a local browser session as local, an unmarked connection as remote', async () => {
  await withDatabase(async ({ runs, runtime, projectPath }) => {
    sessionsDb.createAppSession('s1', 'claude', projectPath, 'S1');
    send(connect(runtime, { id: 1, authKind: 'loopback' }), 'chat.send', 's1');
    await settle();
    send(connect(runtime, { id: 1, authKind: 'session', sessionId: undefined }), 'chat.send', 's1');
    await settle();
    send(connect(runtime, { id: 1 }), 'chat.send', 's1');
    await settle();
    send(connect(runtime, { id: 1, authKind: 'platform' }), 'chat.send', 's1');
    await settle();
    assert.deepEqual(runs.map((run) => run.options.origin), ['remote', 'local', 'remote', 'local']);
  });
});

test('an origin the client claims in chat options never reaches the run, over the bridge or locally', async () => {
  await withDatabase(async ({ runs, runtime, projectPath }) => {
    sessionsDb.createAppSession('s1', 'claude', projectPath, 'S1');
    send(connect(runtime, { id: 1, authKind: 'loopback' }), 'chat.send', 's1', { options: { origin: 'local' } });
    await settle();
    send(connect(runtime, { id: 1, authKind: 'loopback' }), 'chat.edit-send', 's1', { anchorId: 'x', options: { origin: 'local' } });
    await settle();
    send(connect(runtime, { id: 1, authKind: 'session' }), 'chat.send', 's1', { options: { origin: 'garbage' } });
    await settle();
    assert.equal(runs[0].options.origin, 'remote');
    assert.equal(runs[runs.length - 1].options.origin, 'local');
    assert.ok(runs.every((run) => run.options.origin === 'remote' || run.options.origin === 'local'));
  });
});

test('the origin follows the connection that starts this turn, not the session (resume)', async () => {
  await withDatabase(async ({ runs, runtime, projectPath }) => {
    sessionsDb.createAppSession('s1', 'claude', projectPath, 'S1');
    send(connect(runtime, { id: 1, authKind: 'session' }), 'chat.send', 's1');
    await settle();
    sessionsDb.assignProviderSessionId('s1', 'native-1');
    send(connect(runtime, { id: 1, authKind: 'loopback' }), 'chat.send', 's1');
    await settle();
    sessionsDb.assignProviderSessionId('s1', 'native-1');
    send(connect(runtime, { id: 1, authKind: 'session' }), 'chat.send', 's1');
    await settle();
    assert.deepEqual(runs.map((run) => run.options.origin), ['local', 'remote', 'local']);
  });
});

test('a detached turn is remote unless its caller passes local, and options cannot claim local', async () => {
  await withDatabase(async ({ runs, runtime, projectPath }) => {
    sessionsDb.createAppSession('s1', 'claude', projectPath, 'S1');
    const base = { sessionId: 's1', userId: 1, content: 'go' };
    await runDetachedChatTurn({ ...base, options: { origin: 'local' } }, { runtime });
    await runDetachedChatTurn({ ...base, origin: 'local' }, { runtime });
    await runDetachedChatTurn({ ...base, origin: 'bogus' as never }, { runtime });
    await runDetachedChatTurn({ ...base, origin: 'local', options: { origin: 'remote' } }, { runtime });
    assert.deepEqual(runs.map((run) => run.options.origin), ['remote', 'local', 'remote', 'local']);
  });
});
