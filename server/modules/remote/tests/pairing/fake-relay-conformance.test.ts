import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FakeRelay, type FakeRelayHarness } from '../support/fake-relay.js';

/**
 * Runs the relay package's own protocol scenarios (relay/test/conformance/scenarios.ts, the same
 * list the real Worker passes in workerd and under `wrangler dev`) against the in-process fake.
 * If this fails, the fake relay has drifted from the Worker and every ceremony test built on it
 * proves nothing.
 */
type Scenario = { name: string; needs?: 'clock'; run(harness: FakeRelayHarness): Promise<void> };

const scenariosPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../relay/test/conformance/scenarios.ts',
);

const loadScenarios = async (): Promise<Scenario[] | null> => {
  try {
    const loaded = (await import(pathToFileURL(scenariosPath).href)) as { scenarios: Scenario[] };
    return loaded.scenarios;
  } catch (error) {
    // The relay package's dev dependencies (vitest) are not installed: nothing to compare against.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
};

const scenarios = await loadScenarios();

if (scenarios === null) {
  // Silently skipping would remove the only guard against the fake relay drifting from the Worker
  // without any red signal, so a missing relay dev setup FAILS unless the skip is explicit.
  if (process.env.SKIP_RELAY_CONFORMANCE === '1') {
    test('fake relay passes the relay conformance scenarios', { skip: 'SKIP_RELAY_CONFORMANCE=1' }, () => undefined);
  } else {
    test('fake relay passes the relay conformance scenarios', () => {
      assert.fail(
        'The relay conformance scenarios could not be loaded because the relay/ dev dependencies are not installed ' +
          '(run `npm ci` in project/cloud-cli-remote/claudecodeui/relay), or set SKIP_RELAY_CONFORMANCE=1 to skip this guard on purpose.',
      );
    });
  }
} else {
  test('the conformance list is present and covers pair rooms', () => {
    assert.ok(scenarios.length >= 20, `expected the full scenario list, got ${scenarios.length}`);
    assert.ok(scenarios.some((scenario) => scenario.name.startsWith('pair:')));
    assert.ok(scenarios.some((scenario) => scenario.needs === 'clock'));
  });

  for (const scenario of scenarios) {
    test(`fake relay conformance: ${scenario.name}`, { timeout: 30_000 }, async () => {
      // A fresh relay per scenario keeps room state and the virtual clock independent.
      await scenario.run(new FakeRelay().asHarness());
    });
  }
}
