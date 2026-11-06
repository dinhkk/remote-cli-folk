import assert from 'node:assert/strict';
import test from 'node:test';

import { detectUnsupportedRemoteMode } from '../../policy/remote-mode-policy.js';

test('platform mode (VITE_IS_PLATFORM or IS_PLATFORM) is unsupported for both roles: auth is bypassed there', () => {
  for (const env of [{ VITE_IS_PLATFORM: 'true' }, { IS_PLATFORM: 'true' }, { VITE_IS_PLATFORM: 'TRUE' }, { IS_PLATFORM: '1' }, { VITE_IS_PLATFORM: ' true ' }]) {
    assert.equal(detectUnsupportedRemoteMode('host', env), 'platform', JSON.stringify(env));
    assert.equal(detectUnsupportedRemoteMode('controller', env), 'platform', JSON.stringify(env));
  }
});

test('anything else is not platform mode', () => {
  for (const env of [{}, { VITE_IS_PLATFORM: 'false' }, { VITE_IS_PLATFORM: '0' }, { VITE_IS_PLATFORM: '' }, { IS_PLATFORM: 'no' }, { IS_PLATFORM: 'yes' }]) {
    assert.equal(detectUnsupportedRemoteMode('host', env), null, JSON.stringify(env));
    assert.equal(detectUnsupportedRemoteMode('controller', env), null, JSON.stringify(env));
  }
});

test('API_KEY: supported on a Host (the bridge attaches it), unsupported on a Controller', () => {
  assert.equal(detectUnsupportedRemoteMode('host', { API_KEY: 'secret' }), null);
  assert.equal(detectUnsupportedRemoteMode('controller', { API_KEY: 'secret' }), 'controller-api-key');
  assert.equal(detectUnsupportedRemoteMode('controller', { API_KEY: '' }), null);
});

test('platform mode wins over the API_KEY reason', () => {
  assert.equal(detectUnsupportedRemoteMode('controller', { VITE_IS_PLATFORM: 'true', API_KEY: 'k' }), 'platform');
});

test('defaults to the process environment', () => {
  const previous = { platform: process.env.VITE_IS_PLATFORM, legacy: process.env.IS_PLATFORM };
  try {
    delete process.env.IS_PLATFORM;
    process.env.VITE_IS_PLATFORM = 'true';
    assert.equal(detectUnsupportedRemoteMode('host'), 'platform');
    process.env.VITE_IS_PLATFORM = 'false';
    assert.equal(detectUnsupportedRemoteMode('host'), null);
  } finally {
    if (previous.platform === undefined) delete process.env.VITE_IS_PLATFORM;
    else process.env.VITE_IS_PLATFORM = previous.platform;
    if (previous.legacy === undefined) delete process.env.IS_PLATFORM;
    else process.env.IS_PLATFORM = previous.legacy;
  }
});
