import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

test('a database created before the origin columns gains them as nullable, keeping existing rows', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-origin-columns-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    // Recreate the old shape: drop the new columns, leave a row in each table.
    const db = getConnection();
    db.exec('ALTER TABLE scheduled_messages DROP COLUMN origin');
    db.exec('ALTER TABLE session_drafts DROP COLUMN queued_origin');
    closeConnection();
    await initializeDatabase();

    const connection = getConnection();
    const columns = (table: string) => (connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>);
    assert.equal(columns('scheduled_messages').find((column) => column.name === 'origin')?.notnull, 0);
    assert.equal(columns('session_drafts').find((column) => column.name === 'queued_origin')?.notnull, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
