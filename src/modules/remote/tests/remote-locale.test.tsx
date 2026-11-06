import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import { RemoteWarningsPanel } from '@/modules/remote/components/RemoteWarningsPanel';
import type { RemotePeerState } from '@/shared/types';

/**
 * Remote's strings live in the `remote` namespace (English; every other
 * language falls back to it). A key that is used but missing would render as
 * the raw key, so every literal key the module asks for must exist.
 */

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEER_STATES: RemotePeerState[] = ['connecting', 'online', 'offline', 'locked', 'replaced', 'revoked', 'expired'];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

afterEach(async () => {
  await i18n.changeLanguage('en');
});

test('the remote namespace is registered with English strings', () => {
  assert.equal(i18n.hasResourceBundle('en', 'remote'), true);
  const declared = i18n.options.ns;
  assert.ok((Array.isArray(declared) ? declared : [declared]).includes('remote'));
  assert.equal(i18n.t('remote:settings.title'), 'Remote work');
});

test('every literal translation key used by the module exists in the English bundle', () => {
  const missing: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(MODULE_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    // t('a.b') and t("a.b", ...); template-literal keys are covered below.
    for (const match of source.matchAll(/\bt\(\s*(['"])([A-Za-z0-9_.]+)\1/g)) {
      checked += 1;
      const key = match[2] as string;
      const found = i18n.exists(`remote:${key}`) || i18n.exists(`remote:${key}`, { count: 1 });
      if (!found) missing.push(`${path.basename(file)}: ${key}`);
    }
  }

  assert.ok(checked > 40, `expected to find the module's keys, found ${checked}`);
  assert.deepEqual(missing, []);
});

test('the keys built from a state or code exist for every possible value', () => {
  for (const state of PEER_STATES) {
    assert.equal(i18n.exists(`remote:peers.state.${state}`), true, `peers.state.${state}`);
  }
  for (const state of ['revoked', 'replaced', 'locked', 'expired']) {
    assert.equal(i18n.exists(`remote:tabs.state.${state}`), true, `tabs.state.${state}`);
  }
  for (const code of ['REMOTE_LINK_DOWN', 'REMOTE_UPSTREAM_AUTH', 'REMOTE_QUOTA', 'REMOTE_TOO_LARGE', 'REMOTE_PROTOCOL', 'REMOTE_UNSUPPORTED_MODE', 'generic']) {
    assert.equal(i18n.exists(`remote:target.linkError.${code}`), true, `target.linkError.${code}`);
  }
  for (const kind of ['expired', 'wrongCode', 'full', 'rejected', 'generic']) {
    assert.equal(i18n.exists(`remote:pairController.failure.${kind}`), true, `pairController.failure.${kind}`);
  }
});

test('a rendered component shows text, not a raw key', () => {
  render(<RemoteWarningsPanel masterKeySource="file" masterKeyMismatch unsupportedMode approvalTimeoutMs={55000} />);

  for (const alert of screen.getAllByRole('alert')) {
    assert.doesNotMatch(alert.textContent ?? '', /^[a-z]+(\.[A-Za-z]+)+$/);
    assert.ok((alert.textContent ?? '').length > 30);
  }
});

test('a language without a remote bundle falls back to English instead of showing keys', async () => {
  await i18n.changeLanguage('de');
  assert.equal(i18n.hasResourceBundle('de', 'remote'), false);

  render(<RemoteWarningsPanel masterKeySource="file" masterKeyMismatch={false} unsupportedMode={false} approvalTimeoutMs={300000} />);

  assert.match(screen.getByRole('alert').textContent ?? '', /generated into a file/);
});

test('no component carries a hard-coded sentence in its markup', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(MODULE_DIR)) {
    if (!file.endsWith('.tsx')) continue;
    const source = fs.readFileSync(file, 'utf8');
    // JSX text that is a run of two or more words between tags, not an expression.
    for (const match of source.matchAll(/>\s*([A-Z][a-z]+(?: [a-z]+)+[.!?]?)\s*</g)) {
      offenders.push(`${path.basename(file)}: ${match[1]}`);
    }
  }

  assert.deepEqual(offenders, []);
});
