/**
 * Server modes in which Remote must refuse to run (contracts section 1, `REMOTE_UNSUPPORTED_MODE`):
 *
 * - `platform`: `VITE_IS_PLATFORM` / `IS_PLATFORM` make the stock middleware skip token checks, so the
 *   loopback credentials the bridge relies on would mean nothing and every caller would be the user.
 * - `controller-api-key`: a Controller with `API_KEY` set would demand `x-api-key` on `/api/*`, which a
 *   sandboxed tab cannot hold. A Host with `API_KEY` IS supported: the bridge attaches the key itself.
 *
 * The check reads the environment at call time (the shared `IS_PLATFORM` constant is fixed at import).
 */

import type { RemotePairingRole } from '@/shared/types.js';

/** Why Remote refuses to run; `null` from the detector means the mode is supported. */
export type RemoteUnsupportedMode = 'platform' | 'controller-api-key';

const isTruthyFlag = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
};

/**
 * Returns the reason Remote cannot run in this environment for `role`, or null. Consumed by: the Host
 * bridge (refuses every stream in platform mode) and the Remote management service (refuses to enable).
 */
export function detectUnsupportedRemoteMode(role: RemotePairingRole, env: NodeJS.ProcessEnv = process.env): RemoteUnsupportedMode | null {
  if (isTruthyFlag(env.VITE_IS_PLATFORM) || isTruthyFlag(env.IS_PLATFORM)) return 'platform';
  if (role === 'controller' && env.API_KEY) return 'controller-api-key';
  return null;
}
