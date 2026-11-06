// Files the Host serves are untrusted in the Controller's origin: HTML/SVG/anything non-JSON arrives with
// nosniff and a sandbox CSP that forbids script, JSON stays usable by the app. The headers are what keeps an
// `x.html` with a script from running next to the Controller's storage; the browser half (a real tab opening
// the URL) is recorded with evidence in the m1 report, not driven here.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createHostProject, type HostProject } from './support/e2e-host-project.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';

const HTML = '<!doctype html><html><body><script>document.title = "pwned"; fetch("/api/auth/user")</script></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

describe('Host file content is sandboxed in the Controller origin', () => {
  let world: RemoteWorld;
  let project: HostProject;
  let token = '';

  const content = (relativePath: string) =>
    world.viaRemote(`/api/file-tree/projects/${project.id}/files/content?path=${encodeURIComponent(relativePath)}`, { token });

  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
    project = await createHostProject(world.host, 'isolation');
    writeFileSync(path.join(project.dir, 'x.html'), HTML);
    writeFileSync(path.join(project.dir, 'x.svg'), SVG);
    writeFileSync(path.join(project.dir, 'data.json'), '{"a":1}');
    writeFileSync(path.join(project.dir, 'plain.txt'), 'hello');
  });
  after(async () => {
    await world?.stop();
  });

  for (const [file, type] of [
    ['x.html', 'text/html'],
    ['x.svg', 'image/svg+xml'],
    ['plain.txt', 'text/plain'],
  ] as const) {
    it(`${file} is served as ${type} with nosniff and a sandbox CSP, and without cookies or the Host's own policy`, async () => {
      const response = await content(file);
      assert.equal(response.status, 200, response.text);
      assert.match(response.headers.get('content-type') ?? '', new RegExp(type.replace('+', '\\+')));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.match(csp, /\bsandbox\b/);
      assert.match(csp, /default-src 'none'/);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('x-refreshed-token'), null);
    });
  }

  it('the bytes are the Host file as it is (the policy changes headers, never content)', async () => {
    assert.equal((await content('x.html')).text, HTML);
    assert.equal((await content('x.svg')).text, SVG);
  });

  it('JSON is not sandboxed (the app reads it) but still carries nosniff', async () => {
    const response = await content('data.json');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.text, '{"a":1}');
  });

  it('the file API that returns text as JSON hands the script back as a string in a JSON answer', async () => {
    const response = await world.viaRemote(`/api/file-tree/projects/${project.id}/file?filePath=x.html`, { token });
    assert.equal(response.status, 200, response.text);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.json<{ content: string }>().content, HTML);
  });
});
