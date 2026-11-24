/**
 * Every HTML page the server ships loads its scripts and stylesheets from its own origin: the page CSP allows
 * no other host, so a reference to one would only break the page (and would trust that host with the session).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const shippedPages = (): string[] => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((name) => name.endsWith('.html')).map((name) => path.join('public', name));
  for (const indexHtml of ['index.html', path.join('electron', 'launcher', 'index.html')]) {
    if (fs.existsSync(path.join(ROOT, indexHtml))) pages.push(indexHtml);
  }
  return pages;
};

// An absolute or protocol-relative URL: anything that is not a path of the page's own origin.
const OTHER_HOST = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

it('CS-07: no shipped page has a script or stylesheet on another host', () => {
  const pages = shippedPages();
  assert.ok(pages.includes(path.join('public', 'api-docs.html')) && pages.includes('index.html'), pages.join(', '));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const isScript = /^<script/i.test(tag);
      if (!isScript && !/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
      const url = /\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
      if (url === undefined) continue;
      assert.ok(!OTHER_HOST.test(url), `${page}: ${tag}`);
    }
  }
});

it('CS-07: no shipped page uses an inline event handler (the page CSP allows inline scripts by hash only)', () => {
  for (const page of shippedPages()) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const handler = /<[a-z][^>]*\son[a-z]+\s*=/i.exec(html);
    assert.equal(handler, null, `${page}: ${handler?.[0]}`);
  }
});

it('CS-07: every Prism file api-docs.html loads is copied by the client build from the installed prismjs', async () => {
  const { API_DOCS_PRISM_DIR, API_DOCS_PRISM_FILES, API_DOCS_PRISM_VERSION } = await import('../../../../../shared/apiDocsPrismAssets.js');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'api-docs.html'), 'utf8');
  const referenced = [...html.matchAll(/\b(?:src|href)="\/(vendor\/[^"]+)"/g)].map(([, file]) => file);
  const copied = new Map(API_DOCS_PRISM_FILES.map(([source, name]) => [`${API_DOCS_PRISM_DIR}/${name}`, source]));
  assert.equal(referenced.length, API_DOCS_PRISM_FILES.length - 1, referenced.join(', ')); // all but the licence
  const prismRoot = path.dirname(createRequire(import.meta.url).resolve('prismjs/package.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(prismRoot, 'package.json'), 'utf8')).version, API_DOCS_PRISM_VERSION);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/prismjs']?.version, API_DOCS_PRISM_VERSION, 'the served version is the locked one');
  // When the client has been built, the served files are there and equal to the package's.
  const built = path.join(ROOT, 'dist');
  const hasBuild = fs.existsSync(path.join(built, 'index.html'));
  for (const file of referenced) {
    const source = copied.get(file);
    assert.ok(source, `${file} is not copied by the build`);
    assert.ok(fs.existsSync(path.join(prismRoot, source)), source);
    if (hasBuild) assert.deepEqual(fs.readFileSync(path.join(built, file)), fs.readFileSync(path.join(prismRoot, source)), file);
  }
  if (hasBuild) assert.ok(fs.existsSync(path.join(built, API_DOCS_PRISM_DIR, 'LICENSE')));
});
