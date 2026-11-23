import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import webPush from 'web-push';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
  pushSubscriptionsDb,
  notificationPreferencesDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
  notifyRunFailed,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

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
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

test('N-05/K-27: web push carries only a generic result notice, without conversation or file metadata', async (t) => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('push-test', 'synthetic-hash');
    pushSubscriptionsDb.saveSubscription(user.id, 'https://push.example/fixture', 'synthetic-key', 'synthetic-auth');
    notificationPreferencesDb.updatePreferences(user.id, { channels: { webPush: true, desktop: false }, events: { error: true } });
    const payloads: string[] = [];
    t.mock.method(webPush, 'sendNotification', async (_subscription: unknown, payload: string) => {
      payloads.push(payload);
      return { statusCode: 201 };
    });
    notifyRunFailed({ userId: user.id, provider: 'claude', sessionId: 'private-session', sessionName: 'private-file.txt', error: 'private prompt and answer' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(payloads.length, 1);
    assert.deepEqual(JSON.parse(payloads[0]), { title: 'RemoteCLI', body: 'Có kết quả mới', data: { url: '/' } });
  });
});
