import assert from 'node:assert/strict';

import { test } from 'vitest';

import { AUTH_SESSION_EXPIRED_EVENT, expireAuthSession, getStoredAuthToken } from '@/shared/authToken';

test('C-01/K-20: legacy credentials are removed and never returned to a caller', () => {
  for (const token of ['live.legacy.signature', 'expired.legacy.signature', 'malformed']) {
    localStorage.setItem('auth-token', token);
    assert.equal(getStoredAuthToken(), null);
    assert.equal(localStorage.getItem('auth-token'), null);
  }
});

test('K-11: an authoritative server rejection announces session expiry', () => {
  let ended = 0;
  const listener = () => { ended += 1; };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  expireAuthSession();
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  assert.equal(ended, 1);
});
