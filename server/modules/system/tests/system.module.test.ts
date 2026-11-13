import assert from 'node:assert/strict';
import test from 'node:test';

import { runShellCommand } from '../system.module.js';

test('runShellCommand streams stdout, stderr and captures exitCode 0', async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const result = await runShellCommand(
    'node -e "console.log(\'stdout test\'); console.error(\'stderr test\')"',
    process.cwd(),
    process.env,
    (out) => outputs.push(out),
    (err) => errors.push(err),
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /stdout test/);
  assert.match(result.errorOutput, /stderr test/);
  assert.ok(outputs.some((o) => o.includes('stdout test')));
  assert.ok(errors.some((e) => e.includes('stderr test')));
});

test('runShellCommand captures non-zero exit codes', async () => {
  const result = await runShellCommand(
    'node -e "process.exit(42)"',
    process.cwd(),
    process.env,
    () => undefined,
    () => undefined,
  );

  assert.equal(result.exitCode, 42);
});

test('runShellCommand on Windows uses Windows shell instead of sh', async () => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    // When platform is win32, runShellCommand uses shell: true (which delegates to cmd.exe on Windows).
    // On Linux this throws ENOENT for cmd.exe, proving it attempted Windows shell instead of 'sh'.
    await assert.rejects(
      async () => {
        await runShellCommand(
          'echo test',
          process.cwd(),
          process.env,
          () => undefined,
          () => undefined,
        );
      },
      (error: Error) => {
        return error.message.includes('cmd.exe') && !error.message.includes('sh');
      },
    );
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  }
});
