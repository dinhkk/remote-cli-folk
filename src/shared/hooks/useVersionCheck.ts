import { useState, useEffect } from 'react';

import { APP_VERSION } from '@/shared/constants';
import { isTargetMode } from '@/shared/transport/target-context';
import type { InstallMode, ReleaseInfo } from '@/shared/types';

/**
 * What the UI knows about the running install.
 *
 * This fork never asks GitHub for a newer release: the check used to call `api.github.com` every five
 * minutes, which told a third party about every machine using the UI and failed on networks that block
 * it. Updates of this fork are deployed by its operator, so `updateAvailable` stays false and the
 * release fields stay empty (the consumers keep their shape). The only request left is the local
 * `/health`, which reports the install mode and whether the server process runs the version baked
 * into this bundle. Used by Sidebar and AboutTab.
 */
export const useVersionCheck = () => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

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
      } catch {
        // Default to git / no restart hint on error
      }
    };
    fetchHealth();
  }, [disabled]);

  // Typed as nullable (not the literal `null`) so the consumers that read these keep compiling.
  const latestVersion = null as string | null;
  const releaseInfo = null as ReleaseInfo | null;
  return { updateAvailable: false, latestVersion, currentVersion: APP_VERSION, releaseInfo, installMode, runningVersion, restartRequired };
};
