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

test('a same-origin browser socket passes', () => {
  assert.equal(
    isWebSocketOriginAllowed('https://target.example', 'target.example', '/ws', true),
    true
  );
  assert.equal(
    isWebSocketOriginAllowed('http://localhost:3001', 'localhost:3001', '/shell'),
    true
  );
});

test('a cross-origin browser socket is rejected', () => {
  assert.equal(
    isWebSocketOriginAllowed('https://evil.example', 'target.example', '/ws'),
    false
  );
  assert.equal(
    isWebSocketOriginAllowed('null', 'target.example', '/shell'),
    false
  );
  assert.equal(
    isWebSocketOriginAllowed('chrome-extension://abcdef', 'target.example', '/ws'),
    false
  );
});

test('C-06: a missing browser origin is rejected on all paths', () => {
  assert.equal(isWebSocketOriginAllowed(undefined, 'target.example', '/ws'), false);
  assert.equal(isWebSocketOriginAllowed(undefined, '127.0.0.1:3001', '/shell'), false);
});

test('C-05: plugin frames do not bypass the origin policy', () => {
  assert.equal(
    isWebSocketOriginAllowed('null', 'target.example', '/plugin-ws/example'),
    false
  );
});

test('REMOTECLI_ALLOWED_ORIGINS accepts an explicit split-deployment origin', () => {
  withEnv('https://app.example, https://admin.example', () => {
    assert.equal(
      isWebSocketOriginAllowed('https://app.example', 'target.example', '/ws'),
      true
    );
    assert.equal(
      isWebSocketOriginAllowed('https://other.example', 'target.example', '/ws'),
      false
    );
  });
});

test('the gateway delegates credential classification and origin checks to the auth adapter', () => {
  const request = info('/ws', { host: 'target.example', origin: 'https://target.example' });
  let calls = 0;
  const rejected = verifyWebSocketClient(request as never, {
    isPlatform: false,
    authenticateWebSocket: (incoming) => { calls += 1; assert.equal(incoming, request.req); return null; },
  });
  assert.equal(rejected, false);
  assert.equal(calls, 1);
  const user = { userId: 1, username: 'tester', authKind: 'loopback' };
  assert.equal(verifyWebSocketClient(info('/shell', {}) as never, {
    isPlatform: false, authenticateWebSocket: () => user,
  }), true);
});
