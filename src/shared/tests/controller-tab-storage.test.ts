import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  applyTabStorageWrite,
  purgeRemoteTabStorage,
  readTabStorageSnapshot,
} from '@/shared/transport/controller-tab-storage';

/**
 * A Remote tab is untrusted code, and everything it stores lands in the
 * Controller's own localStorage. These limits keep one tab (or all of them
 * together) from filling the quota the Controller's own app needs, and keep the
 * per-write cost flat: sizes come from an in-memory ledger, not a rescan.
 */

const set = (peer: string, key: string, value: string | null, area = 'local') =>
  applyTabStorageWrite(peer, { type: 'storage-set', area, key, value });
const stored = (peer: string, key: string, area = 'local') => localStorage.getItem(`remote:${peer}:${area}:${key}`);
const remoteKeys = () =>
  Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) as string).filter((key) =>
    key.startsWith('remote:'),
  );

beforeEach(() => {
  localStorage.clear();
  purgeRemoteTabStorage();
});

test('a write lands under remote:<peer>:<area>:<key> and nowhere else', () => {
  set('peer_a', 'activeTab', 'git');

  assert.equal(stored('peer_a', 'activeTab'), 'git');
  assert.equal(localStorage.getItem('activeTab'), null);
  set('peer_a', 'activeTab', null);
  assert.equal(stored('peer_a', 'activeTab'), null);
});

test('the session area is kept in memory only: never in localStorage, but kept for the next frame of this page', () => {
  set('peer_a', 'draft', 'hello', 'session');

  assert.deepEqual(remoteKeys(), []);
  assert.deepEqual(readTabStorageSnapshot('peer_a'), { local: {}, session: { draft: 'hello' } });
  assert.deepEqual(readTabStorageSnapshot('peer_b'), { local: {}, session: {} });

  set('peer_a', 'draft', null, 'session');
  assert.deepEqual(readTabStorageSnapshot('peer_a').session, {});
});

test('a session entry that an older build persisted is dropped, not handed to the tab', () => {
  localStorage.setItem('remote:peer_a:session:old', 'x');
  localStorage.setItem('remote:peer_a:local:keep', 'y');

  assert.deepEqual(readTabStorageSnapshot('peer_a'), { local: { keep: 'y' }, session: {} });
  assert.equal(localStorage.getItem('remote:peer_a:session:old'), null);
});

test('one message is capped, so a single huge value is dropped', () => {
  set('peer_a', 'big', 'x'.repeat(70_000));
  set('peer_a', 'ok', 'x'.repeat(60_000));

  assert.equal(stored('peer_a', 'big'), null);
  assert.equal(stored('peer_a', 'ok')?.length, 60_000);
});

test('a key that is too long, not a string or not a known area is dropped', () => {
  set('peer_a', 'k'.repeat(300), '1');
  set('peer_a', 'a', '1', 'cookies');
  applyTabStorageWrite('peer_a', { area: 'local', key: 5, value: '1' });
  applyTabStorageWrite('peer_a', { area: 'local', key: 'n', value: 5 });
  applyTabStorageWrite('peer_a', { area: 'local', key: '', value: '1' });

  assert.deepEqual(remoteKeys(), []);
});

test('one tab is capped at 256 KiB in total and at 200 entries', () => {
  for (let index = 0; index < 8; index += 1) set('peer_a', `big${index}`, 'x'.repeat(60_000));
  const used = remoteKeys().length;
  assert.equal(used, 4, 'four 60 000-character values fit in 256 KiB, the rest do not');

  // Overwriting a key replaces its size instead of adding to it.
  set('peer_a', 'big0', 'y'.repeat(60_000));
  assert.equal(stored('peer_a', 'big0')?.[0], 'y');

  localStorage.clear();
  purgeRemoteTabStorage();
  for (let index = 0; index < 400; index += 1) set('peer_b', `k${index}`, '1');
  assert.equal(remoteKeys().length, 200);
});

test('all tabs together are capped at 1 MiB, so five tabs cannot all fill their share', () => {
  const peers = ['peer_1', 'peer_2', 'peer_3', 'peer_4', 'peer_5'];
  for (const peer of peers) {
    for (let index = 0; index < 4; index += 1) set(peer, `v${index}`, 'x'.repeat(62_000));
  }

  const total = remoteKeys().reduce((sum, key) => sum + key.length + (localStorage.getItem(key)?.length ?? 0), 0);
  assert.ok(total <= 1024 * 1024, `stored ${total}`);
  assert.equal(stored('peer_5', 'v0'), null, 'the fifth tab is refused once the shared budget is spent');
  assert.notEqual(stored('peer_1', 'v0'), null);

  // Freeing space gives it back.
  set('peer_1', 'v0', null);
  set('peer_5', 'v0', 'x'.repeat(62_000));
  assert.notEqual(stored('peer_5', 'v0'), null);
});

test('writes do not rescan localStorage: the cost per message stays flat', () => {
  set('peer_a', 'warm', '1');
  const originalKey = Storage.prototype.key;
  let keyReads = 0;
  Storage.prototype.key = function patched(this: Storage, index: number) {
    keyReads += 1;
    return originalKey.call(this, index);
  };
  try {
    for (let index = 0; index < 100; index += 1) set('peer_a', `k${index % 20}`, String(index));
  } finally {
    Storage.prototype.key = originalKey;
  }

  assert.equal(keyReads, 0);
});

test('clear() removes one area of one tab only', () => {
  set('peer_a', 'a', '1');
  set('peer_a', 's', '1', 'session');
  set('peer_b', 'b', '1');
  localStorage.setItem('unrelated', 'keep');

  applyTabStorageWrite('peer_a', { area: 'local', key: null, value: null });

  assert.equal(stored('peer_a', 'a'), null);
  assert.equal(stored('peer_b', 'b'), '1');
  assert.equal(localStorage.getItem('unrelated'), 'keep');
  assert.deepEqual(readTabStorageSnapshot('peer_a').session, { s: '1' });
});

test('purging one peer removes its entries (both areas) and leaves the others', () => {
  set('peer_a', 'a', '1');
  set('peer_a', 's', '1', 'session');
  set('peer_b', 'b', '1');
  localStorage.setItem('unrelated', 'keep');

  purgeRemoteTabStorage('peer_a');

  assert.deepEqual(readTabStorageSnapshot('peer_a'), { local: {}, session: {} });
  assert.equal(stored('peer_b', 'b'), '1');
  assert.equal(localStorage.getItem('unrelated'), 'keep');
  // peer_a1 shares a text prefix with peer_a but is another pairing.
  set('peer_a1', 'x', '1');
  purgeRemoteTabStorage('peer_a');
  assert.equal(stored('peer_a1', 'x'), '1');
});

test('purging everything removes every remote:* entry and nothing else', () => {
  set('peer_a', 'a', '1');
  set('peer_b', 's', '1', 'session');
  localStorage.setItem('auth-token', 'controller-jwt');

  purgeRemoteTabStorage();

  assert.deepEqual(remoteKeys(), []);
  assert.deepEqual(readTabStorageSnapshot('peer_b'), { local: {}, session: {} });
  assert.equal(localStorage.getItem('auth-token'), 'controller-jwt');
});
