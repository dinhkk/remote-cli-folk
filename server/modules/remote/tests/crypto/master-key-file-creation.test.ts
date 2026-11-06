/**
 * Creating the master key file is exclusive: whatever file already sits at the path (a key another process
 * created between our "no file" check and our create) is never truncated or replaced, and the existing key is
 * adopted. Two server processes on one HOME can both reach the create path; they must end with the same key.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveMasterKey, type MasterKeyStore } from '../../crypto/master-key.js';

const emptyStore = (): MasterKeyStore => {
  let keyId: string | null = null;
  return { readKeyId: () => keyId, writeKeyId: (id) => void (keyId = id), hasSealedData: () => false };
};

const withTempDir = (run: (dir: string) => void): void => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'master-key-create-'));
  try {
    run(dir);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

type FsPatch = Partial<Pick<typeof nodeFs, 'openSync' | 'linkSync'>>;
const patchedFs = (patch: FsPatch): typeof nodeFs => ({ ...nodeFs, ...patch }) as typeof nodeFs;
const base64 = (key: Buffer): string => `${key.toString('base64')}\n`;

test('the key file is created with exclusive flags only (never a plain truncating open) and mode 0600', () => {
  withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'sub', 'remote-master.key');
    const opens: Array<{ file: string; flags: unknown }> = [];
    const fs = patchedFs({
      openSync: ((file: nodeFs.PathLike, flags: nodeFs.OpenMode, mode?: nodeFs.Mode) => {
        opens.push({ file: String(file), flags });
        return nodeFs.openSync(file, flags, mode);
      }) as typeof nodeFs.openSync,
    });
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: emptyStore(), fs });
    assert.equal(resolved.created, true);
    assert.ok(opens.length >= 1);
    for (const open of opens) assert.equal(open.flags, 'wx', `${open.file} opened with ${String(open.flags)}`);
    assert.equal(nodeFs.readFileSync(keyFilePath, 'utf8'), base64(resolved.key));
    if (process.platform !== 'win32') assert.equal(nodeFs.statSync(keyFilePath).mode & 0o777, 0o600);
    assert.deepEqual(nodeFs.readdirSync(path.dirname(keyFilePath)), ['remote-master.key'], 'no temp file is left behind');
  });
});

test('a key file another process created in the meantime is adopted, not overwritten (hard-link path)', () => {
  withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const winner = crypto.randomBytes(32);
    const fs = patchedFs({
      linkSync: ((existing: nodeFs.PathLike, target: nodeFs.PathLike) => {
        nodeFs.writeFileSync(keyFilePath, base64(winner)); // the other process wins the race right before our link
        return nodeFs.linkSync(existing, target);
      }) as typeof nodeFs.linkSync,
    });
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: emptyStore(), fs });
    assert.equal(resolved.created, false, 'we did not create the key');
    assert.ok(resolved.key.equals(winner), 'the winner key is the one in use');
    assert.equal(nodeFs.readFileSync(keyFilePath, 'utf8'), base64(winner), 'the winner file is untouched');
    assert.deepEqual(nodeFs.readdirSync(dir), ['remote-master.key']);
  });
});

test('a key file another process created in the meantime is adopted, not overwritten (file system without hard links)', () => {
  withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const winner = crypto.randomBytes(32);
    const fs = patchedFs({
      linkSync: (() => {
        nodeFs.writeFileSync(keyFilePath, base64(winner));
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }) as typeof nodeFs.linkSync,
    });
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: emptyStore(), fs });
    assert.equal(resolved.created, false);
    assert.ok(resolved.key.equals(winner));
    assert.equal(nodeFs.readFileSync(keyFilePath, 'utf8'), base64(winner), 'the exclusive fallback write did not replace it');
  });
});

test('an existing key file is never opened for writing at all', () => {
  withTempDir((dir) => {
    const keyFilePath = path.join(dir, 'remote-master.key');
    const existing = crypto.randomBytes(32);
    nodeFs.writeFileSync(keyFilePath, base64(existing));
    const fs = patchedFs({
      openSync: (() => {
        throw new Error('no file may be opened for writing');
      }) as typeof nodeFs.openSync,
    });
    const resolved = resolveMasterKey({ env: {}, keyFilePath, store: emptyStore(), fs });
    assert.equal(resolved.created, false);
    assert.ok(resolved.key.equals(existing));
  });
});
