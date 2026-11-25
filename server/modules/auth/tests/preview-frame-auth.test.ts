import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticatePreviewFrame } from '../services/preview-frame-auth.service.js';
import type { SessionRequest } from '../services/session-transport.service.js';

const PATH = '/api/file-tree/projects/p-1/files/html-preview';
const FRAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', host: '127.0.0.1:3001' };
const secret = 'A'.repeat(43);

const request = (headers: Record<string, string>, method = 'GET'): SessionRequest & { method: string } =>
  ({ method, headers, socket: { remoteAddress: '127.0.0.1' }, secure: false }) as unknown as SessionRequest & { method: string };

test('a request that is not a frame load of the preview page is not handled here', () => {
  const cookie = { cookie: `remotecli_session=${secret}` };
  assert.equal(authenticatePreviewFrame(request({ ...FRAME, ...cookie }, 'POST'), PATH), null);
  assert.equal(authenticatePreviewFrame(request({ ...FRAME, ...cookie }, 'HEAD'), PATH), null);
  for (const name of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) {
    const missing: Record<string, string> = { ...FRAME, ...cookie };
    delete missing[name];
    assert.equal(authenticatePreviewFrame(request(missing), PATH), null, `missing ${name}`);
    assert.equal(authenticatePreviewFrame(request({ ...FRAME, ...cookie, [name]: 'cross-site' }), PATH), null, `wrong ${name}`);
  }
  assert.equal(authenticatePreviewFrame(request({ ...FRAME, ...cookie, origin: 'https://evil.example' }), PATH), null, 'foreign origin');
  for (const path of [`${PATH}/`, `${PATH}/extra`, `${PATH}x`, PATH.toUpperCase(), PATH.replace('/files/', '%2Ffiles/'), '/api/file-tree/projects/p-1/files/content', '/api/projects']) {
    assert.equal(authenticatePreviewFrame(request({ ...FRAME, ...cookie }), path), null, path);
  }
});

test('a frame load with an Authorization header is refused, whatever else it carries', () => {
  const verdict = authenticatePreviewFrame(request({ ...FRAME, cookie: `remotecli_session=${secret}`, authorization: 'Bearer anything' }), PATH);
  assert.deepEqual(verdict && !verdict.ok && [verdict.status, verdict.code], [401, 'AUTH_TOKEN_INVALID']);
});

test('a frame load with no cookie, or a cookie that is not a session secret, is refused with 401', () => {
  for (const headers of [{ ...FRAME }, { ...FRAME, cookie: 'remotecli_session=short' }, { ...FRAME, cookie: 'other=1' }]) {
    const verdict = authenticatePreviewFrame(request(headers), PATH);
    assert.deepEqual(verdict && !verdict.ok && [verdict.status, verdict.code], [401, 'AUTH_TOKEN_INVALID']);
  }
});
