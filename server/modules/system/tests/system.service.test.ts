import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSystemUpdateService,
  isNewerVersion,
  type SystemUpdateDependencies,
} from '../system.service.js';

function createDependencies(
  overrides: Partial<SystemUpdateDependencies> = {},
): SystemUpdateDependencies {
  return {
    appRoot: '/app/remotecli',
    homeDirectory: '/home/remotecli',
    installMode: 'git',
    isPlatform: false,
    packageName: '@tunghuynh/remotecli',
    currentVersion: '1.0.0',
    environment: { TEST_ENVIRONMENT: 'true' },
    runShellCommand: async () => ({ exitCode: 0, output: 'updated', errorOutput: '' }),
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('git installations update from the application root', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: 'git update complete', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.updateSystem();

  assert.deepEqual(calls, [[
    'git checkout main && git pull && npm install',
    '/app/remotecli',
    dependencies.environment,
  ]]);
  assert.deepEqual(result, {
    success: true,
    output: 'git update complete',
    message: 'Update completed. Please restart the server to apply changes.',
  });
});

test('global npm installations update from the user home directory with @tunghuynh/remotecli', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: '', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.updateSystem();

  assert.deepEqual(calls, [[
    'npm install -g @tunghuynh/remotecli@latest',
    '/home/remotecli',
    dependencies.environment,
  ]]);
  assert.equal(result.output, 'Update completed successfully');
});

test('npm installations use custom packageName when provided', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    packageName: '@custom/cli',
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: '', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  await service.updateSystem();

  assert.equal(calls[0]?.[0], 'npm install -g @custom/cli@latest');
});

test('platform installations use the platform workflow regardless of install mode', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    isPlatform: true,
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: 'platform update complete', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  await service.updateSystem();

  assert.deepEqual(calls, [[
    'npm run update:platform',
    '/app/remotecli',
    dependencies.environment,
  ]]);
});

test('failed update commands retain stdout and stderr for the existing API contract', async () => {
  const service = createSystemUpdateService(createDependencies({
    runShellCommand: async () => ({
      exitCode: 1,
      output: 'installing',
      errorOutput: 'npm failed',
    }),
  }));

  assert.deepEqual(await service.updateSystem(), {
    success: false,
    error: 'Update command failed',
    output: 'installing',
    errorOutput: 'npm failed',
  });
});

test('EACCES permission errors return helpful manual instruction message', async () => {
  const service = createSystemUpdateService(createDependencies({
    installMode: 'npm',
    packageName: '@tunghuynh/remotecli',
    runShellCommand: async () => ({
      exitCode: 1,
      output: '',
      errorOutput: 'npm ERR! code EACCES\nnpm ERR! syscall access\nnpm ERR! permission denied',
    }),
  }));

  const result = await service.updateSystem();
  assert.equal(result.success, false);
  assert.match(
    (result as { error: string }).error,
    /Permission denied\. Please run manually: npm update -g @tunghuynh\/remotecli/,
  );
});

test('process startup errors retain their message for the existing API contract', async () => {
  const service = createSystemUpdateService(createDependencies({
    runShellCommand: async () => {
      throw new Error('spawn sh failed');
    },
  }));

  assert.deepEqual(await service.updateSystem(), {
    success: false,
    error: 'spawn sh failed',
  });
});

test('isNewerVersion correctly compares semantic versions', () => {
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
  assert.equal(isNewerVersion('v1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
});

test('checkSystemVersion checks latest version and detects available updates', async () => {
  let fetchCount = 0;
  const dependencies = createDependencies({
    currentVersion: '1.0.0',
    fetchLatestVersion: async () => {
      fetchCount += 1;
      return '1.1.0';
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.checkSystemVersion();

  assert.equal(fetchCount, 1);
  assert.deepEqual(result, {
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateAvailable: true,
  });
});

test('checkSystemVersion caches registry responses for cacheTtl duration', async () => {
  let currentTime = 1000;
  let fetchCount = 0;
  const dependencies = createDependencies({
    currentVersion: '1.0.0',
    cacheTtlMs: 3600_000,
    getCurrentTime: () => currentTime,
    fetchLatestVersion: async () => {
      fetchCount += 1;
      return '1.0.0';
    },
  });
  const service = createSystemUpdateService(dependencies);

  const firstResult = await service.checkSystemVersion();
  assert.equal(fetchCount, 1);
  assert.equal(firstResult.updateAvailable, false);

  // Fast forward within cache TTL
  currentTime += 1800_000; // 30 minutes
  const secondResult = await service.checkSystemVersion();
  assert.equal(fetchCount, 1, 'Should use cached version without fetching');
  assert.equal(secondResult.updateAvailable, false);

  // Fast forward past cache TTL
  currentTime += 2000_000; // > 1 hour
  await service.checkSystemVersion();
  assert.equal(fetchCount, 2, 'Should re-fetch after cache TTL expires');
});

test('checkSystemVersion falls back gracefully on fetch errors without crashing', async () => {
  const dependencies = createDependencies({
    currentVersion: '1.0.0',
    fetchLatestVersion: async () => {
      throw new Error('Network unreachable');
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.checkSystemVersion();

  assert.deepEqual(result, {
    currentVersion: '1.0.0',
    latestVersion: null,
    updateAvailable: false,
  });
});
