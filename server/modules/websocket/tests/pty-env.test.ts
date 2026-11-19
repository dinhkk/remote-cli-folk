import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPtyEnv } from '@/modules/websocket/services/shell-websocket.service.js';

test('the PTY environment drops the app-owned secrets and keeps the rest', () => {
  const env = buildPtyEnv({
    PATH: '/usr/bin',
    HOME: '/home/node',
    ANTHROPIC_AUTH_TOKEN: 'provider-token',
    CLOUDCLI_REMOTE_MASTER_KEY: 'master-key',
    CLOUDCLI_SETUP_TOKEN: 'setup-token',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/node');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'provider-token');
  assert.equal('CLOUDCLI_REMOTE_MASTER_KEY' in env, false);
  assert.equal('CLOUDCLI_SETUP_TOKEN' in env, false);
});

test('the filter is case-insensitive and does not mutate the source', () => {
  const source = {
    PATH: '/usr/bin',
    cloudcli_remote_master_key: 'lowercase',
    CloudCli_Setup_Token: 'mixed',
  };

  const env = buildPtyEnv(source);

  assert.deepEqual(Object.keys(env), ['PATH']);
  assert.equal(source.cloudcli_remote_master_key, 'lowercase');
  assert.equal(source.CloudCli_Setup_Token, 'mixed');
});
