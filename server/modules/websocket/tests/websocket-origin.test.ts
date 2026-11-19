import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWebSocketOriginAllowed,
  verifyWebSocketClient,
} from '@/modules/websocket/services/websocket-auth.service.js';

const withEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env.REMOTECLI_ALLOWED_ORIGINS;
  if (value === undefined) delete process.env.REMOTECLI_ALLOWED_ORIGINS;
  else process.env.REMOTECLI_ALLOWED_ORIGINS = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.REMOTECLI_ALLOWED_ORIGINS;
    else process.env.REMOTECLI_ALLOWED_ORIGINS = previous;
  }
};

const info = (url: string, headers: Record<string, string | undefined>) => ({
  origin: '',
  secure: false,
  req: { url, headers },
});

const acceptAll = {
  isPlatform: true,
  authenticateWebSocket: () => ({ id: 1, username: 'tester' }),
};

test('a same-origin browser socket passes', () => {
  assert.equal(
    isWebSocketOriginAllowed('https://chat.vibexai.net', 'chat.vibexai.net', '/ws'),
    true
  );
  assert.equal(
    isWebSocketOriginAllowed('http://localhost:3001', 'localhost:3001', '/shell'),
    true
  );
});

test('a cross-origin browser socket is rejected', () => {
  assert.equal(
    isWebSocketOriginAllowed('https://evil.example', 'chat.vibexai.net', '/ws'),
    false
  );
  assert.equal(
    isWebSocketOriginAllowed('null', 'chat.vibexai.net', '/shell'),
    false
  );
  assert.equal(
    isWebSocketOriginAllowed('chrome-extension://abcdef', 'chat.vibexai.net', '/ws'),
    false
  );
});

test('a missing origin is left to token authentication (Host bridge, CLI clients)', () => {
  assert.equal(isWebSocketOriginAllowed(undefined, 'chat.vibexai.net', '/ws'), true);
  assert.equal(isWebSocketOriginAllowed(undefined, '127.0.0.1:3001', '/shell'), true);
});

test('paths outside /ws and /shell keep their existing behaviour (plugin frames)', () => {
  assert.equal(
    isWebSocketOriginAllowed('null', 'chat.vibexai.net', '/plugin-ws/example'),
    true
  );
});

test('REMOTECLI_ALLOWED_ORIGINS accepts an explicit split-deployment origin', () => {
  withEnv('https://app.example, https://admin.example', () => {
    assert.equal(
      isWebSocketOriginAllowed('https://app.example', 'chat.vibexai.net', '/ws'),
      true
    );
    assert.equal(
      isWebSocketOriginAllowed('https://other.example', 'chat.vibexai.net', '/ws'),
      false
    );
  });
});

test('verifyWebSocketClient rejects a cross-origin upgrade before authentication', () => {
  // verifyClient is called with `isPlatform: false`, so a cross-origin request
  // must be refused even when the token would be valid.
  const dependencies = {
    isPlatform: false,
    authenticateWebSocket: () => ({ id: 1, username: 'tester' }),
  };
  const rejected = verifyWebSocketClient(
    info('/ws?token=abc', { host: 'chat.vibexai.net', origin: 'https://evil.example' }) as never,
    dependencies
  );
  assert.equal(rejected, false);

  const accepted = verifyWebSocketClient(
    info('/ws?token=abc', { host: 'chat.vibexai.net', origin: 'https://chat.vibexai.net' }) as never,
    dependencies
  );
  assert.equal(accepted, true);
});

test('verifyWebSocketClient still accepts the host bridge, which sends no origin', () => {
  const accepted = verifyWebSocketClient(
    info('/shell', { host: '127.0.0.1:3001' }) as never,
    acceptAll
  );
  assert.equal(accepted, true);
});
