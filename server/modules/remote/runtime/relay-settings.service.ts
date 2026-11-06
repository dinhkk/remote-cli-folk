/**
 * The relay URL and `RELAY_SECRET` of `/relay-config` (contracts section 2).
 *
 * The secret is write-only (never returned) and must be at least 32 characters, the same floor the relay
 * enforces (a shorter one would make the relay answer 503 to everything). The UI and operators paste the
 * relay's https address, which is saved as the wss address the link needs. Changing the URL or the secret
 * revokes every pairing, Host and Controller side, BEFORE anything new is stored (neither the URL nor the
 * secret): revoking a Host pairing asks the old relay to destroy the room and that request is
 * authenticated with the old settings. The input is validated first, so a bad URL revokes nothing; if
 * the revoke itself throws nothing is saved, and if saving fails half-way the old URL is put back.
 * Pairings that could not be revoked are counted and reported, not hidden.
 */

import { AppError } from '@/shared/utils.js';

import type { createRemoteConfigService } from '../storage/remote-storage.service.js';

const MIN_RELAY_SECRET_LENGTH = 32;
const MAX_RELAY_SECRET_LENGTH = 1024;

type RemoteConfig = ReturnType<typeof createRemoteConfigService>;

export type RelaySettingsOptions = {
  config: Pick<RemoteConfig, 'getRelayUrl' | 'setRelayUrl' | 'normalizeRelayUrl' | 'hasRelaySecret' | 'getRelaySecret' | 'setRelaySecret'>;
  /** Where the master key came from (`GET /relay-config` shows it). */
  masterKeySource(): 'env' | 'file';
  /** Revokes every Host pairing and forgets every Controller pairing; reports how many could not be revoked. */
  revokeAll(): Promise<{ failed: number } | void>;
};

/** `url` is an empty string while none is saved (the UI reads it as a string and shows the empty form). */
export type RelayConfigView = { url: string; hasSecret: boolean; masterKeySource: 'env' | 'file' };

const badRequest = (message: string): AppError => new AppError(message, { statusCode: 400, code: 'REMOTE_BAD_REQUEST' });

/** `https://` and `http://` are the same address as `wss://` and `ws://`; the storage keeps only the latter. */
const toWebSocketScheme = (url: string): string => url.trim().replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');

/**
 * Creates the relay settings service.
 * Consumed by: the management API.
 */
export function createRelaySettingsService({ config, masterKeySource, revokeAll }: RelaySettingsOptions) {
  return {
    view(): RelayConfigView {
      return { url: config.getRelayUrl() ?? '', hasSecret: config.hasRelaySecret(), masterKeySource: masterKeySource() };
    },

    /**
     * Saves both values (the UI always sends both). Throws `AppError` / `RemoteConfigError` (400) for bad input.
     * `revocationFailures` counts the pairings that could not be revoked when the settings changed.
     */
    async update(input: { url?: unknown; secret?: unknown }): Promise<{ revocationFailures: number }> {
      const { url, secret } = input;
      if (typeof url !== 'string' || typeof secret !== 'string') throw badRequest('Both url and secret are required.');
      if (secret.length < MIN_RELAY_SECRET_LENGTH || secret.length > MAX_RELAY_SECRET_LENGTH) {
        throw new AppError(`The relay secret must be ${MIN_RELAY_SECRET_LENGTH}-${MAX_RELAY_SECRET_LENGTH} characters.`, {
          statusCode: 400,
          code: 'INVALID_RELAY_SECRET',
        });
      }
      // Validates and normalizes without saving; a bad URL throws here with nothing changed.
      const nextUrl = config.normalizeRelayUrl(toWebSocketScheme(url));

      const previousUrl = config.getRelayUrl();
      const hadSecret = config.hasRelaySecret();
      const previousSecret = hadSecret ? config.getRelaySecret() : null;

      const changed = (previousUrl !== null || hadSecret) && (previousUrl !== nextUrl || previousSecret !== secret);
      const outcome = changed ? await revokeAll() : undefined;

      try {
        config.setRelayUrl(nextUrl);
        config.setRelaySecret(secret);
      } catch (error) {
        if (previousUrl !== null && config.getRelayUrl() !== previousUrl) config.setRelayUrl(previousUrl);
        throw error;
      }
      return { revocationFailures: outcome?.failed ?? 0 };
    },
  };
}

export type RelaySettingsService = ReturnType<typeof createRelaySettingsService>;
