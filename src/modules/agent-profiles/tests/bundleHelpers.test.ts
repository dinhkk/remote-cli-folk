import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import {
  BUNDLE_CODES,
  MAX_BUNDLE_BYTES,
  SKIP_FOLDER,
  buildImportOptions,
  isBundleTooLarge,
  sensitiveReasonKey,
  sourceFolders,
} from '@/modules/agent-profiles/bundle/bundle-helpers';
import { makeFolderRow, makePlanItem } from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { ImportPlan } from '@/shared/types';

const PLAN: ImportPlan = {
  hasFolderText: true,
  items: [
    makePlanItem({ key: 'template:alpha', status: 'conflict', overwritable: true, basis: 3, sensitive: ['skills'] }),
    makePlanItem({
      key: 'block:beta',
      status: 'conflict',
      overwritable: true,
      basis: 2,
      folders: [
        makeFolderRow({ key: 'block:beta#k1', sourceKey: 'k1', sourceDirectory: '/src/one', status: 'conflict', overwritable: true, basis: 5 }),
        makeFolderRow({ key: 'block:beta#k2', sourceKey: 'k2', sourceDirectory: '/src/two' }),
      ],
    }),
    makePlanItem({
      key: 'block:gamma',
      folders: [makeFolderRow({ key: 'block:gamma#k1', sourceKey: 'k1', sourceDirectory: '/src/one' })],
    }),
  ],
};

describe('isBundleTooLarge', () => {
  it('allows exactly 5 MB and refuses one byte more', () => {
    expect(isBundleTooLarge('a'.repeat(MAX_BUNDLE_BYTES))).toBe(false);
    expect(isBundleTooLarge('a'.repeat(MAX_BUNDLE_BYTES + 1))).toBe(true);
  });

  it('counts bytes, not characters', () => {
    expect(isBundleTooLarge('é'.repeat(MAX_BUNDLE_BYTES / 2 + 1))).toBe(true);
  });
});

describe('sourceFolders', () => {
  it('lists each source folder once, in first-seen order', () => {
    expect(sourceFolders(PLAN)).toEqual([
      { sourceKey: 'k1', sourceDirectory: '/src/one' },
      { sourceKey: 'k2', sourceDirectory: '/src/two' },
    ]);
  });

  it('is empty when the bundle has no folder text', () => {
    expect(sourceFolders({ items: [makePlanItem({ key: 'template:alpha' })], hasFolderText: false })).toEqual([]);
  });
});

describe('buildImportOptions', () => {
  it('sends nothing by default', () => {
    expect(buildImportOptions(PLAN, { overwrite: new Set(), acceptSensitive: new Set(), projectMap: {} })).toEqual({
      overwrite: [], acceptSensitive: [], projectMap: {}, basis: {},
    });
  });

  it('copies the basis of every ticked item and folder row from the plan', () => {
    const options = buildImportOptions(PLAN, {
      overwrite: new Set(['block:beta', 'block:beta#k1']),
      acceptSensitive: new Set(['template:alpha']),
      projectMap: {},
    });
    expect(options.overwrite).toEqual(['block:beta', 'block:beta#k1']);
    expect(options.acceptSensitive).toEqual(['template:alpha']);
    expect(options.basis).toEqual({ 'block:beta': 2, 'block:beta#k1': 5, 'template:alpha': 3 });
  });

  it('drops ticks of keys the plan no longer has', () => {
    const options = buildImportOptions(PLAN, { overwrite: new Set(['template:gone']), acceptSensitive: new Set(), projectMap: {} });
    expect(options.overwrite).toEqual([]);
    expect(options.basis).toEqual({});
  });

  it('maps folders to project ids and leaves skipped folders out', () => {
    const options = buildImportOptions(PLAN, {
      overwrite: new Set(), acceptSensitive: new Set(), projectMap: { k1: 'sp-alpha', k2: SKIP_FOLDER },
    });
    expect(options.projectMap).toEqual({ k1: 'sp-alpha' });
  });
});

describe('translations of the bundle texts', () => {
  it('has an English string for every item code and sensitive reason', () => {
    const keys = [
      ...BUNDLE_CODES.map((code) => `bundle.codes.${code}`),
      ...['mcpServers', 'no-tools', 'skills'].map((reason) => sensitiveReasonKey(reason).key),
      sensitiveReasonKey('tool:Bash').key,
    ];
    expect(keys.filter((key) => !i18n.exists(`agentProfiles:${key}`, { lng: 'en' }))).toEqual([]);
  });
});
