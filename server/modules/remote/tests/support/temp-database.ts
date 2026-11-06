/**
 * Runs a test against a throwaway SQLite database (DATABASE_PATH in the OS temp directory, never
 * inside the source tree) with the full schema applied, then restores the environment.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeConnection, getDatabasePath, initializeDatabase } from '@/modules/database/index.js';

export const withTempDatabase = async (run: (databasePath: string) => void | Promise<void>): Promise<void> => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-db-'));
  const databasePath = path.join(directory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  try {
    if (!getDatabasePath().startsWith(os.tmpdir())) throw new Error('test database must live in the OS temp directory');
    await run(databasePath);
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
};
