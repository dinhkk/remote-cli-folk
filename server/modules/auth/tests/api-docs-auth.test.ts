import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
test('R7-07: public API docs distinguish browser cookies from header-only automation keys', () => {
  const html = readFileSync(new URL('../../../../public/api-docs.html', import.meta.url), 'utf8');
  assert.match(html, /__Host-remotecli_session/);
  assert.match(html, /X-RemoteCLI-Request: 1/);
  assert.match(html, /never as query parameters/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.doesNotMatch(html, /localStorage.getItem|Authorization: `Bearer|All API requests require authentication using an API key/);
});
