import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('N-04/K-28: the real service worker never intercepts or serves API responses from cache', () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let cacheReads = 0, intercepted = 0;
  vm.runInNewContext(readFileSync(new URL('../../../../public/sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (event: string, handler: (event: unknown) => void) => handlers.set(event, handler) },
    caches: { match: () => { cacheReads += 1; return Promise.resolve('stale private response'); } },
  });
  const onFetch = handlers.get('fetch')!;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const url of ['https://target.example/api/projects', 'https://target.example/r/peer/api/projects']) {
      onFetch({ request: { url }, respondWith: () => { intercepted += 1; } });
    }
  }
  assert.equal(cacheReads, 0);
  assert.equal(intercepted, 0);
});
