export type VersionCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
};

export type SystemUpdateCommandResult = {
  exitCode: number | null;
  output: string;
  errorOutput: string;
};

export type SystemUpdateDependencies = {
  appRoot: string;
  homeDirectory: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  packageName?: string;
  currentVersion?: string;
  environment: NodeJS.ProcessEnv;
  runShellCommand(
    command: string,
    workingDirectory: string,
    environment: NodeJS.ProcessEnv,
    onOutput: (output: string) => void,
    onErrorOutput: (errorOutput: string) => void,
  ): Promise<SystemUpdateCommandResult>;
  fetchLatestVersion?(packageName: string): Promise<string | null>;
  getCurrentTime?(): number;
  cacheTtlMs?: number;
  logInfo(message: string, detail?: string): void;
  logError(message: string, detail?: string): void;
};

export function isNewerVersion(candidateVersion: string, currentVersion: string): boolean {
  const cleanCandidate = (candidateVersion.replace(/^v/, '').split('-')[0] ?? '').trim();
  const cleanCurrent = (currentVersion.replace(/^v/, '').split('-')[0] ?? '').trim();
  const candidateParts = cleanCandidate.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const currentParts = cleanCurrent.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(candidateParts.length, currentParts.length); i += 1) {
    const candidate = candidateParts[i] ?? 0;
    const current = currentParts[i] ?? 0;
    if (candidate > current) return true;
    if (candidate < current) return false;
  }
  return false;
}

export async function fetchLatestNpmVersion(
  packageName: string,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const encodedName = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);
    const registryUrl = `https://registry.npmjs.org/${encodedName}/latest`;
    const response = await fetch(registryUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { version?: string };
    return typeof data?.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Creates the update workflow used by the system module and its focused tests.
 * Runtime-specific process spawning stays behind the injected command adapter.
 */
export function createSystemUpdateService(dependencies: SystemUpdateDependencies) {
  let cachedVersion: { version: string; timestamp: number } | null = null;
  let inFlightPromise: Promise<string | null> | null = null;
  const cacheTtl = dependencies.cacheTtlMs ?? 60 * 60 * 1000; // 1 hour
  const getCurrentTime = dependencies.getCurrentTime ?? (() => Date.now());

  const getLatestVersion = async (): Promise<string | null> => {
    const now = getCurrentTime();
    if (cachedVersion && now - cachedVersion.timestamp < cacheTtl) {
      return cachedVersion.version;
    }
    if (inFlightPromise) {
      return inFlightPromise;
    }

    const packageName = dependencies.packageName || '@tunghuynh/remotecli';
    const fetcher = dependencies.fetchLatestVersion ?? fetchLatestNpmVersion;

    inFlightPromise = (async () => {
      try {
        const latest = await fetcher(packageName);
        if (latest !== null) {
          cachedVersion = {
            version: latest,
            timestamp: now,
          };
        }
        return latest;
      } catch {
        return cachedVersion?.version ?? null;
      } finally {
        inFlightPromise = null;
      }
    })();

    return inFlightPromise;
  };

  return {
    async checkSystemVersion(): Promise<VersionCheckResult> {
      const currentVersion = dependencies.currentVersion || '1.0.0';
      try {
        const latestVersion = await getLatestVersion();
        const updateAvailable = Boolean(latestVersion && isNewerVersion(latestVersion, currentVersion));
        return {
          currentVersion,
          latestVersion,
          updateAvailable,
        };
      } catch {
        return {
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
        };
      }
    },

    /** Selects and executes the correct update workflow for this installation. */
    async updateSystem() {
      const packageName = dependencies.packageName || '@tunghuynh/remotecli';
      const updateCommand = dependencies.isPlatform
        ? 'npm run update:platform'
        : dependencies.installMode === 'git'
          ? 'git checkout main && git pull && npm install'
          : `npm install -g ${packageName}@latest`;
      const workingDirectory = dependencies.isPlatform || dependencies.installMode === 'git'
        ? dependencies.appRoot
        : dependencies.homeDirectory;

      dependencies.logInfo('Starting system update from directory:', workingDirectory);

      try {
        const result = await dependencies.runShellCommand(
          updateCommand,
          workingDirectory,
          dependencies.environment,
          (output) => dependencies.logInfo('Update output:', output),
          (errorOutput) => dependencies.logError('Update error:', errorOutput),
        );

        if (result.exitCode === 0) {
          return {
            success: true as const,
            output: result.output || 'Update completed successfully',
            message: 'Update completed. Please restart the server to apply changes.',
          };
        }

        let errorMessage = 'Update command failed';
        const combinedOutput = `${result.errorOutput || ''} ${result.output || ''}`;
        if (/EACCES|permission denied/i.test(combinedOutput)) {
          errorMessage = `Permission denied. Please run manually: npm update -g ${packageName} or check npm permissions.`;
        }

        return {
          success: false as const,
          error: errorMessage,
          output: result.output,
          errorOutput: result.errorOutput,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logError('Update process error:', message);
        return {
          success: false as const,
          error: message,
        };
      }
    },
  };
}
