import os from 'node:os';

import spawn from 'cross-spawn';
import type { Router } from 'express';

import { createSystemRouter } from './system.routes.js';
import { createSystemUpdateService, type VersionCheckResult } from './system.service.js';

type SystemModuleOptions = {
  appRoot: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  packageName?: string;
  currentVersion?: string;
};

export type SystemRouterModule = Router & {
  checkSystemVersion(): Promise<VersionCheckResult>;
};

export function runShellCommand(
  command: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  onOutput: (output: string) => void,
  onErrorOutput: (errorOutput: string) => void,
): Promise<{ exitCode: number | null; output: string; errorOutput: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const childProcess = isWindows
      ? spawn(command, {
          cwd: workingDirectory,
          env: environment,
          shell: true,
        })
      : spawn('sh', ['-c', command], {
          cwd: workingDirectory,
          env: environment,
        });
    let output = '';
    let errorOutput = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      onOutput(text);
    });
    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      errorOutput += text;
      onErrorOutput(text);
    });
    childProcess.once('error', reject);
    childProcess.once('close', (exitCode) => {
      resolve({ exitCode, output, errorOutput });
    });
  });
}

/**
 * Builds the authenticated system router for the server entrypoint using the
 * installation details it already resolves for health and startup metadata.
 */
export function createSystemModule(options: SystemModuleOptions): SystemRouterModule {
  const systemUpdateService = createSystemUpdateService({
    ...options,
    homeDirectory: os.homedir(),
    environment: process.env,
    runShellCommand,
    logInfo: (message, detail) => console.log(message, detail ?? ''),
    logError: (message, detail) => console.error(message, detail ?? ''),
  });

  const router = createSystemRouter(systemUpdateService) as SystemRouterModule;
  router.checkSystemVersion = () => systemUpdateService.checkSystemVersion();
  return router;
}
