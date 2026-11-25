import assert from 'node:assert/strict';
import test from 'node:test';

import { isSessionContentTypeAllowed } from '../services/api-session-guard.service.js';
import {
  clearSessionCookie, isLocalSessionRequest, isSessionHttpRequestAllowed,
  isSessionOriginAllowed, readAuthTransportConfig, readSessionCookie, sessionCookie,
  type SessionRequest,
} from '../services/session-transport.service.js';

const config = readAuthTransportConfig({});
const request = (headers: SessionRequest['headers'] = {}, secure = false): SessionRequest => ({
  headers: { host: 'localhost:3001', origin: 'http://localhost:3001', 'x-remotecli-request': '1', ...headers },
  socket: { remoteAddress: '127.0.0.1' }, secure,
});

test('C-01/C-07: HTTPS cookies are host-prefixed, Secure, HttpOnly, Strict and never Domain cookies', () => {
  const cookie = sessionCookie(request({}, true), 'a'.repeat(43), 701000, 1000);
  assert.ok(cookie.startsWith('__Host-remotecli_session='));
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Secure', 'Max-Age=700']) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes('Domain='));
  const local = sessionCookie(request(), 'a'.repeat(43), 701000, 1000);
  assert.ok(local.startsWith('remotecli_session='));
  assert.ok(!local.includes('Secure'));
  assert.ok(!local.includes('__Host-'));
  assert.ok(clearSessionCookie(request({}, true)).includes('Max-Age=0; Secure'));
});

test('C-07: reject duplicate or malformed cookies and never accept an insecure cookie as a secure session', () => {
  const secret = 'a'.repeat(43);
  assert.equal(readSessionCookie(request({ cookie: `remotecli_session=${secret}` })), secret);
  assert.equal(readSessionCookie(request({ cookie: `remotecli_session=${secret}` }, true)), null);
  assert.equal(readSessionCookie(request({ cookie: `__Host-remotecli_session=${secret}` }, true)), secret);
  assert.equal(readSessionCookie(request({ cookie: `remotecli_session=${secret}; remotecli_session=${secret}` })), null);
  assert.equal(readSessionCookie(request({ cookie: 'remotecli_session=%00' })), null);
});

test('C-02/C-03/K-03/K-04/K-05: require header and a permitted browser origin, including same-site subdomains', () => {
  assert.equal(isSessionHttpRequestAllowed(request(), config), true);
  assert.equal(isSessionHttpRequestAllowed(request({ 'x-remotecli-request': undefined }), config), false);
  assert.equal(isSessionHttpRequestAllowed(request({ origin: 'null' }), config), false);
  assert.equal(isSessionHttpRequestAllowed(request({ origin: 'https://other.example' }), config), false);
  assert.equal(isSessionHttpRequestAllowed(request({ 'sec-fetch-site': 'same-site' }), config), false);
  assert.equal(isSessionHttpRequestAllowed(request({ origin: undefined, 'sec-fetch-site': 'same-origin' }), config), true);
  assert.equal(isSessionHttpRequestAllowed(request({ origin: undefined }), config), false);
  assert.equal(isSessionHttpRequestAllowed(request({ origin: ['http://localhost:3001'] }), config), false);
});

test('C-05/C-06/K-06: cookie upgrades always require Origin and enforce protocol as well as host', () => {
  assert.equal(isSessionOriginAllowed(request({ origin: undefined }), config), false);
  assert.equal(isSessionOriginAllowed(request({ origin: 'null' }), config), false);
  assert.equal(isSessionOriginAllowed(request({ host: 'ctl.example', origin: 'http://ctl.example' }, true), config), false);
  assert.equal(isSessionOriginAllowed(request({ host: 'ctl.example', origin: 'https://ctl.example' }, true), config), true);
  assert.equal(isSessionOriginAllowed(request({ origin: 'http://user:pass@localhost:3001' }), config), false);
});

test('C-05: loopback aliases work only on permitted server/Vite ports without proxy trust', () => {
  assert.equal(isSessionOriginAllowed(request({ origin: 'http://[::1]:5173' }), config), true);
  assert.equal(isSessionOriginAllowed(request({ origin: 'http://localhost:9000' }), config), false);
  assert.equal(isSessionOriginAllowed(request({ origin: 'http://localhost:5173' }), readAuthTransportConfig({ TRUST_PROXY: '1' })), false);
  const fromLan = request({ origin: 'http://localhost:5173' });
  fromLan.socket.remoteAddress = '192.0.2.10';
  assert.equal(isLocalSessionRequest(fromLan, config), false);
  assert.equal(isSessionOriginAllowed(fromLan, config), false);
});

test('C-05: origin config rejects wildcard, credentials, and non-origin URLs at startup', () => {
  for (const value of ['*', 'https://*.example', 'https://user:pass@ctl.example', 'https://ctl.example/path', 'null']) {
    assert.throws(() => readAuthTransportConfig({ REMOTECLI_ALLOWED_ORIGINS: value }));
  }
  const extra = readAuthTransportConfig({ REMOTECLI_ALLOWED_ORIGINS: 'https://ctl.example, https://ctl.example' });
  assert.equal(extra.origins.length, 1);
  assert.equal(isSessionOriginAllowed(request({ origin: 'https://ctl.example' }), extra), true);
  assert.throws(() => readAuthTransportConfig({ VITE_PORT: '5173garbage' }));
});

test('C-04a/C-04b/K-29/K-31: multipart exceptions match exactly four upload routes and POST only', () => {
  for (const route of ['/api/assets/images', '/api/assets/files', '/api/file-tree/projects/synthetic/files/upload', '/api/voice/transcribe']) {
    assert.equal(isSessionContentTypeAllowed('POST', route, 'multipart/form-data; boundary=synthetic'), true);
    assert.equal(isSessionContentTypeAllowed('PUT', route, 'multipart/form-data; boundary=synthetic'), false);
    assert.equal(isSessionContentTypeAllowed('POST', route + '/extra', 'multipart/form-data'), false);
  }
  for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    assert.equal(isSessionContentTypeAllowed('POST', '/api/settings', contentType), false);
  }
  assert.equal(isSessionContentTypeAllowed('POST', '/api/settings', 'application/json; charset=utf-8'), true);
});
