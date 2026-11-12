import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Base directory for RemoteCLI user configuration and data (defaults to ~/.remotecli). */
export function getRemoteCliConfigDir(): string {
  return (
    process.env.REMOTECLI_CONFIG_DIR ||
    process.env.CLOUDCLI_CONFIG_DIR ||
    path.join(os.homedir(), '.remotecli')
  );
}

/** Legacy configuration directory (~/.cloudcli) for migration. */
export function getLegacyCloudCliConfigDir(): string {
  return (
    process.env.CLOUDCLI_CONFIG_DIR ||
    path.join(os.homedir(), '.cloudcli')
  );
}

export function getDefaultDatabasePath(): string {
  return path.join(getRemoteCliConfigDir(), 'auth.db');
}

export function getDefaultAssetsDir(): string {
  return path.join(getRemoteCliConfigDir(), 'assets');
}

export function getDefaultMasterKeyFilePath(): string {
  return (
    process.env.REMOTECLI_MASTER_KEY_FILE ||
    process.env.CLOUDCLI_REMOTE_MASTER_KEY_FILE ||
    path.join(getRemoteCliConfigDir(), 'remote-master.key')
  );
}

export function getLocalServerMarkerPath(): string {
  return path.join(getRemoteCliConfigDir(), 'local-server.json');
}

export function getDefaultBrowserUseProfileRoot(): string {
  return path.join(getRemoteCliConfigDir(), 'browser-use', 'profiles');
}

/**
 * Ensures ~/.remotecli exists at boot. If ~/.remotecli does not exist but legacy
 * ~/.cloudcli exists, recursively copies all data from ~/.cloudcli into ~/.remotecli
 * while preserving ~/.cloudcli intact as a safe backup.
 */
export function ensureRemoteCliDirectoryAndMigrateLegacy(): void {
  const targetDir = getRemoteCliConfigDir();
  const legacyDir = getLegacyCloudCliConfigDir();
  try {
    if (!fs.existsSync(targetDir)) {
      if (fs.existsSync(legacyDir)) {
        console.log(`[migration] Copying legacy data from ${legacyDir} to ${targetDir}...`);
        fs.cpSync(legacyDir, targetDir, { recursive: true });
        console.log(`[migration] Migration complete. Preserved backup at ${legacyDir}`);
      } else {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    }
  } catch (error: any) {
    console.error('[migration] Failed to copy legacy directory:', error?.message || error);
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch {}
  }
}
