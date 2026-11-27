import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';

/**
 * UI-X2: every string of the Agent Profiles screens goes through the app's i18n. `fallbackLng: 'en'` hides a missing
 * key by rendering the key itself, so this reads every `t('...')` literal in the module and asks i18next whether the
 * English bundle has it, then does the same for the key families built at run time.
 */

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full);
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : [];
  });

/** Whether the key resolves, for plain keys and for plural keys (`_one` / `_other`) alike. */
const resolves = (key: string): boolean => (
  i18n.exists(`agentProfiles:${key}`, { lng: 'en' })
  || i18n.exists(`agentProfiles:${key}`, { lng: 'en', count: 1 })
  || i18n.exists(`agentProfiles:${key}`, { lng: 'en', count: 2 })
);

describe('Agent Profiles translations', () => {
  const keys = [...new Set(sourceFiles(MODULE_DIR).flatMap((file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([^'$]+)'/g)].map((match) => match[1])))];

  it('finds the keys the module uses (guard against the scan silently matching nothing)', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it('has an English string for every key the module uses', () => {
    expect(keys.filter((key) => !resolves(key))).toEqual([]);
  });

  it('has a string for every key family built at run time', () => {
    const dynamic = [
      ...['agents', 'templates', 'memory'].map((id) => `tabs.${id}`),
      ...['writable', 'read-only'].map((mode) => `memory.mode.${mode}`),
      ...['writable', 'read-only'].map((mode) => `memory.form.modeHint.${mode}`),
      ...['writerNone', 'writerUser', 'writerAgent'].map((key) => `memory.${key}`),
      ...['orchestrator', 'worker'].map((family) => `family.${family}`),
      ...['text', 'dir', 'file', 'url'].map((type) => `params.types.${type}`),
      ...['invalid', 'reserved', 'duplicate'].map((problem) => `params.keyProblem.${problem}`),
      ...['new', 'duplicate', 'missing-values', 'invalid-name', 'handmade-exists', 'write-failed'].map((status) => `generate.status.${status}`),
      ...['project', 'user', 'local'].map((scope) => `template.memoryScope.${scope}`),
      ...['PROFILE_STALE', 'SLUG_TAKEN', 'DIRECTORY_NOT_FOUND', 'DIRECTORY_NOT_A_DIRECTORY', 'PROFILE_CORRUPT', 'BLOCK_NAME_TAKEN', 'BLOCK_LIMIT_REACHED', 'BLOCK_CONTENT_LIMIT_REACHED', 'BLOCK_CONTENT_EXISTS'].map((code) => `errors.${code}`),
      ...['global', 'project'].map((kind) => `memory.form.scopeHint.${kind}`),
      ...['one', 'other'].map((plural) => `memory.folders.corrupt_${plural}`),
    ];
    expect(dynamic.filter((key) => !resolves(key))).toEqual([]);
  });

  it('labels the settings tab', () => {
    expect(i18n.t('settings:mainTabs.agentProfiles', { lng: 'en' })).toBe('Agent Profiles');
  });
});
