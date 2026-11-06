/**
 * Relay settings (`/relay-config`): the secret is write-only and at least 32 characters, an https URL is
 * saved as wss, and changing the URL or the secret revokes every pairing (contracts section 2) BEFORE the
 * new secret replaces the old one, so the DESTROY of the old rooms is still authenticated.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createSecretBox } from '../../crypto/secret-box.js';
import { createRelaySettingsService } from '../../runtime/relay-settings.service.js';
import { createRemoteConfigService, RemoteConfigError } from '../../storage/remote-storage.service.js';
import { withTempDatabase } from '../support/temp-database.js';

const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);

const arrange = () => {
  const config = createRemoteConfigService({ box: createSecretBox(crypto.randomBytes(32)) });
  const revocations: Array<{ url: string | null; secret: string | null }> = [];
  const service = createRelaySettingsService({
    config,
    masterKeySource: () => 'file',
    revokeAll: () => {
      // What the DESTROY of the old rooms is authenticated with: still the OLD settings.
      revocations.push({ url: config.getRelayUrl(), secret: config.getRelaySecret() });
      return Promise.resolve();
    },
  });
  return { config, service, revocations };
};

const rejection = async (run: () => Promise<unknown>): Promise<AppError | RemoteConfigError> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof AppError || error instanceof RemoteConfigError, String(error));
    return error;
  }
  throw new Error('expected a rejection');
};

describe('relay settings', () => {
  it('starts empty and never returns the secret', async () => {
    await withTempDatabase(async () => {
      const { service } = arrange();
      assert.deepEqual(service.view(), { url: '', hasSecret: false, masterKeySource: 'file' });
      await service.update({ url: 'wss://relay.example.com', secret: SECRET_A });
      const view = service.view();
      assert.deepEqual(view, { url: 'wss://relay.example.com', hasSecret: true, masterKeySource: 'file' });
      assert.ok(!JSON.stringify(view).includes(SECRET_A));
    });
  });

  it('refuses a secret shorter than 32 characters with a clear code, and saves nothing', async () => {
    await withTempDatabase(async () => {
      const { service, config } = arrange();
      const error = await rejection(() => service.update({ url: 'wss://relay.example.com', secret: 'short' }));
      assert.equal((error as AppError).code, 'INVALID_RELAY_SECRET');
      assert.equal((error as AppError).statusCode, 400);
      assert.equal(config.getRelayUrl(), null);
      assert.equal(config.hasRelaySecret(), false);
    });
  });

  it('refuses a missing or non-string url or secret', async () => {
    await withTempDatabase(async () => {
      const { service } = arrange();
      for (const input of [{ url: 5, secret: SECRET_A }, { url: 'wss://relay.example.com' }, {}, { url: 'wss://relay.example.com', secret: 7 }]) {
        const error = await rejection(() => service.update(input as never));
        assert.equal((error as AppError).code, 'REMOTE_BAD_REQUEST');
      }
    });
  });

  it('saves an https:// address as wss:// (the form most operators paste) and http:// loopback as ws://', async () => {
    await withTempDatabase(async () => {
      const { service, config } = arrange();
      await service.update({ url: 'https://relay.example.com/', secret: SECRET_A });
      assert.equal(config.getRelayUrl(), 'wss://relay.example.com');
      await service.update({ url: 'http://127.0.0.1:8787', secret: SECRET_A });
      assert.equal(config.getRelayUrl(), 'ws://127.0.0.1:8787');
    });
  });

  it('rejects an address the storage refuses (plain ws to a remote host) as a 400 config error', async () => {
    await withTempDatabase(async () => {
      const { service } = arrange();
      const error = await rejection(() => service.update({ url: 'http://relay.example.com', secret: SECRET_A }));
      assert.ok(error instanceof RemoteConfigError);
      assert.equal(error.code, 'INVALID_RELAY_URL');
    });
  });

  it('the first save revokes nothing; saving the same values again revokes nothing', async () => {
    await withTempDatabase(async () => {
      const { service, revocations } = arrange();
      await service.update({ url: 'wss://relay.example.com', secret: SECRET_A });
      await service.update({ url: 'wss://relay.example.com', secret: SECRET_A });
      assert.equal(revocations.length, 0);
    });
  });

  it('changing the URL or the secret revokes everything first, while the old settings are still saved', async () => {
    await withTempDatabase(async () => {
      const { service, config, revocations } = arrange();
      await service.update({ url: 'wss://one.example.com', secret: SECRET_A });

      await service.update({ url: 'wss://two.example.com', secret: SECRET_A });
      assert.equal(revocations.length, 1);
      assert.equal(revocations[0].secret, SECRET_A);

      await service.update({ url: 'wss://two.example.com', secret: SECRET_B });
      assert.equal(revocations.length, 2);
      assert.equal(revocations[1].secret, SECRET_A, 'the old secret was still in place during the revoke');
      assert.equal(config.getRelaySecret(), SECRET_B);
      assert.equal(config.getRelayUrl(), 'wss://two.example.com');
    });
  });

  it('revokes while BOTH old values are still saved (the URL is written only after the revoke)', async () => {
    await withTempDatabase(async () => {
      const { service, revocations } = arrange();
      await service.update({ url: 'wss://one.example.com', secret: SECRET_A });
      await service.update({ url: 'wss://two.example.com', secret: SECRET_B });
      assert.deepEqual(revocations[0], { url: 'wss://one.example.com', secret: SECRET_A });
    });
  });

  it('a revoke that fails leaves the saved URL and secret as they were, and the error reaches the caller', async () => {
    await withTempDatabase(async () => {
      const config = createRemoteConfigService({ box: createSecretBox(crypto.randomBytes(32)) });
      const service = createRelaySettingsService({
        config,
        masterKeySource: () => 'file',
        revokeAll: () => Promise.reject(new Error('revoke blew up')),
      });
      config.setRelayUrl('wss://one.example.com');
      config.setRelaySecret(SECRET_A);
      await assert.rejects(() => service.update({ url: 'wss://two.example.com', secret: SECRET_B }), /revoke blew up/);
      assert.equal(config.getRelayUrl(), 'wss://one.example.com');
      assert.equal(config.getRelaySecret(), SECRET_A);
    });
  });

  it('reports how many pairings could not be revoked, and still saves the new settings', async () => {
    await withTempDatabase(async () => {
      const config = createRemoteConfigService({ box: createSecretBox(crypto.randomBytes(32)) });
      const service = createRelaySettingsService({ config, masterKeySource: () => 'file', revokeAll: () => Promise.resolve({ failed: 2 }) });
      config.setRelayUrl('wss://one.example.com');
      config.setRelaySecret(SECRET_A);
      assert.deepEqual(await service.update({ url: 'wss://two.example.com', secret: SECRET_B }), { revocationFailures: 2 });
      assert.equal(config.getRelayUrl(), 'wss://two.example.com');
      assert.equal(config.getRelaySecret(), SECRET_B);
      assert.deepEqual(await service.update({ url: 'wss://two.example.com', secret: SECRET_B }), { revocationFailures: 0 });
    });
  });

  it('puts the old URL back when saving the secret fails after the URL was written', async () => {
    await withTempDatabase(async () => {
      const real = createRemoteConfigService({ box: createSecretBox(crypto.randomBytes(32)) });
      real.setRelayUrl('wss://one.example.com');
      real.setRelaySecret(SECRET_A);
      const config = {
        getRelayUrl: () => real.getRelayUrl(),
        setRelayUrl: (url: string) => real.setRelayUrl(url),
        normalizeRelayUrl: (url: string) => real.normalizeRelayUrl(url),
        hasRelaySecret: () => real.hasRelaySecret(),
        getRelaySecret: () => real.getRelaySecret(),
        setRelaySecret: () => {
          throw new Error('disk full');
        },
      };
      const service = createRelaySettingsService({ config, masterKeySource: () => 'file', revokeAll: () => Promise.resolve() });
      await assert.rejects(() => service.update({ url: 'wss://two.example.com', secret: SECRET_B }), /disk full/);
      assert.equal(real.getRelayUrl(), 'wss://one.example.com');
      assert.equal(real.getRelaySecret(), SECRET_A);
    });
  });

  it('an invalid URL changes nothing and revokes nothing', async () => {
    await withTempDatabase(async () => {
      const { service, config, revocations } = arrange();
      await service.update({ url: 'wss://one.example.com', secret: SECRET_A });
      await rejection(() => service.update({ url: 'not a url', secret: SECRET_B }));
      assert.equal(revocations.length, 0);
      assert.equal(config.getRelayUrl(), 'wss://one.example.com');
      assert.equal(config.getRelaySecret(), SECRET_A);
    });
  });
});
