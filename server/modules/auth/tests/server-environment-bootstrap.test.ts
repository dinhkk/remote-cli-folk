import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Database } from '../../database/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('V-05/R-15: direct server entry loads .env before evaluating Platform authentication', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'remotecli-server-env-'));
  try {
    await mkdir(path.join(fixture, 'server'));
    for (const name of await readdir(path.join(root, 'server'))) {
      const source = path.join(root, 'server', name);
      const target = path.join(fixture, 'server', name);
      if (name === 'index.ts' || name === 'load-env.ts') await copyFile(source, target);
      else await symlink(source, target);
    }
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    await symlink(path.join(root, 'shared'), path.join(fixture, 'shared'), 'dir');
    await copyFile(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    const databasePath = path.join(fixture, 'auth.db');
    const db = new Database(databasePath);
    db.exec('CREATE TABLE auth_totp (enabled INTEGER); INSERT INTO auth_totp VALUES (1)');
    db.close();
    await writeFile(path.join(fixture, '.env'), 'VITE_IS_PLATFORM=true\n');
    const env = { ...process.env, HOME: fixture, USERPROFILE: fixture,
      DATABASE_PATH: databasePath, REMOTECLI_CONFIG_DIR: path.join(fixture, 'config'),
      CLOUDCLI_CONFIG_DIR: path.join(fixture, 'legacy'), HOST: '127.0.0.1', SERVER_PORT: '31123' };
    delete (env as NodeJS.ProcessEnv).VITE_IS_PLATFORM;
    const child = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      '--tsconfig', path.join(root, 'server/tsconfig.json'), path.join(fixture, 'server/index.ts')],
    { cwd: fixture, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stdout + child.stderr, /Platform authentication cannot be used while TOTP is enabled/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
