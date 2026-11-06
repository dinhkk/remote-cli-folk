// Dev helper for the browser half of the M1 verification: starts the relay and two paired servers, writes
// their addresses and a tab token to tests/e2e-remote/.out/world.json, then stays alive until killed.
// Usage: tsx --tsconfig server/tsconfig.json tests/e2e-remote/support/serve-world.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { startWorld } from './e2e-world.js';
import { FORK_ROOT } from './e2e-util.js';

const world = await startWorld();
const tabToken = await world.tabToken();
const outDir = path.join(FORK_ROOT, 'tests', 'e2e-remote', '.out');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, 'world.json'),
  JSON.stringify({
    controller: world.controller.baseUrl,
    host: world.host.baseUrl,
    peerId: world.peerId,
    username: world.controller.username,
    password: world.controller.password,
    jwt: world.controller.jwt,
    tabToken,
  }),
);
console.log('world ready');

const shutdown = async (): Promise<void> => {
  await world.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
setInterval(() => undefined, 60_000);
