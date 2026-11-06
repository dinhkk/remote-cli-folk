import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { TEST_RELAY_SECRET } from './test/support/reference-gate';

// Self-contained: stops vitest from walking up to the fork's root (jsdom) config.
//
// Two projects:
//  - "workers": runs inside real workerd via @cloudflare/vitest-plugin (Worker + Durable Object).
//    WebSockets + Durable Objects are not supported with per-file storage isolation, so this
//    project runs `isolate: false` in a single worker; tests isolate themselves with unique room ids.
//  - "node": plain Node tests (static guards, vector sync, and the conformance run that talks to a
//    real `wrangler dev` process over the `ws` library).
const SHARED_WORKERS_TESTS = [
  'test/gate.test.ts',
  'test/room-*.test.ts',
  'test/pair-room.test.ts',
  'test/hibernation.test.ts',
  'test/conformance.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // Must be at least as long as the relay's minimum secret length (32).
              bindings: { RELAY_SECRET: TEST_RELAY_SECRET },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: SHARED_WORKERS_TESTS,
          isolate: false,
          fileParallelism: false,
          testTimeout: 20_000,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/static-guards.test.ts', 'test/vector-sync.test.ts'],
          sequence: { groupOrder: 2 },
        },
      },
      {
        test: {
          name: 'wrangler',
          environment: 'node',
          include: ['test/wrangler-dev.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});
