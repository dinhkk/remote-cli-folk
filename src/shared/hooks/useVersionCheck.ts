import { useState, useEffect } from 'react';

import { APP_VERSION } from '@/shared/constants';
import { isTargetMode } from '@/shared/transport/target-context';
import type { InstallMode, ReleaseInfo } from '@/shared/types';

/**
 * What the UI knows about the running install.
 *
 * Checks the local backend `/health` endpoint to obtain the running version,
 * installation mode, and any latest available version discovered by the backend's
 * cached NPM registry check. Remote target tabs skip this check as they do not
 * talk directly to local host health routes.
 */
export const useVersionCheck = () => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // A Remote tab does not ask its Host for /health: it is not on the Host's allow-list.
  const disabled = isTargetMode();

  useEffect(() => {
    if (disabled) return;
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        // `data.version` is the version the server process is actually running.
        // This module's `version` is baked into the frontend bundle at build
        // time, so it reflects the installed (on-disk) package. If they differ,
        // the package was updated but the server process was not restarted, and
        // DB-backed actions may silently fail until it is.
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRunningVersion(data.version);
          setRestartRequired(data.version !== APP_VERSION);
        }
        if (typeof data.latestVersion === 'string' && data.latestVersion.length > 0) {
          setLatestVersion(data.latestVersion);
        }
        if (typeof data.updateAvailable === 'boolean') {
          setUpdateAvailable(data.updateAvailable);
        }
      } catch {
        // Default to git / no restart hint on error
      }
    };
    fetchHealth();
  }, [disabled]);

  const releaseInfo = null as ReleaseInfo | null;
  return {
    updateAvailable,
    latestVersion,
    currentVersion: APP_VERSION,
    releaseInfo,
    installMode,
    runningVersion,
    restartRequired,
  };
};
