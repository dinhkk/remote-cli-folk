import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { extractPlaceholderKeys, isValidAgentProfileName } from '@/shared/utils.js';

import { defaultDescription, effectiveValues, renderInstructions } from '../agent-profiles.resolve.js';
import { parseTemplateInput } from '../agent-profiles.validation.js';

/**
 * Drift guard: the web client keeps copies of these rules for previews and form warnings
 * (src/shared/utils.ts). The same golden cases run against the client copies in
 * src/shared/tests/agentProfileGoldenCases.test.ts; a rule changed on one side fails here or there.
 */

type Repeat = [string, number];
const golden = JSON.parse(fs.readFileSync(new URL('../../../../shared/agent-profile-golden-cases.json', import.meta.url), 'utf8'));

/** Expands the `{64x}` shorthand of the golden file into that many x characters. */
const expand = (text: string): string => text.replace(/\{(\d+)x\}/g, (_match, count: string) => 'x'.repeat(Number(count)));

for (const item of golden.render) {
  test(`golden render: ${item.name}`, () => {
    const values: Record<string, string> = { ...item.values };
    for (const [key, [character, count]] of Object.entries((item.valuesRepeat ?? {}) as Record<string, Repeat>)) values[key] = character.repeat(count);
    const expected = item.expectedRepeat
      ? `${item.expectedRepeat.prefix}${item.expectedRepeat.repeat[0].repeat(item.expectedRepeat.repeat[1])}${item.expectedRepeat.suffix}`
      : item.expected;
    assert.equal(renderInstructions(item.instructions, values), expected);
  });
}

for (const item of golden.effectiveValues) {
  test(`golden effective values: ${item.name}`, () => {
    assert.deepEqual(effectiveValues({ params: item.params }, item.project, item.agentValues), item.expected);
  });
}

for (const item of golden.defaultDescription) {
  test(`golden default description: ${item.name}`, () => {
    assert.equal(defaultDescription(item.template), item.expected);
  });
}

for (const item of golden.placeholderKeys) {
  test(`golden placeholder keys: ${item.text}`, () => {
    assert.deepEqual(extractPlaceholderKeys(item.text), item.expected);
  });
}

const accepts = (run: () => unknown): boolean => {
  try { run(); return true; } catch (error) { if ((error as { code?: string }).code === 'INVALID_PROFILE_INPUT') return false; throw error; }
};
const templateWithSlug = (slug: string) => ({ slug, family: 'worker', name: 'T', description: '', instructions: 'text', params: [] });
const templateWithKey = (key: string) => ({
  slug: 'ok', family: 'worker', name: 'T', description: '', instructions: 'text',
  params: [{ key, type: 'text', title: '', description: '', required: false }],
});

test('golden slug patterns agree with the server validation', () => {
  for (const slug of golden.slugs.valid) assert.equal(accepts(() => parseTemplateInput(templateWithSlug(slug))), true, `slug ${slug}`);
  for (const slug of golden.slugs.invalid) assert.equal(accepts(() => parseTemplateInput(templateWithSlug(slug))), false, `slug ${slug}`);
});

test('golden parameter key patterns agree with the server validation', () => {
  for (const key of golden.paramKeys.valid) assert.equal(accepts(() => parseTemplateInput(templateWithKey(key))), true, `key ${key}`);
  for (const key of golden.paramKeys.invalid) assert.equal(accepts(() => parseTemplateInput(templateWithKey(key))), false, `key ${key}`);
});

test('golden agent name patterns agree with the server', () => {
  for (const name of golden.agentNames.valid) assert.equal(isValidAgentProfileName(expand(name)), true, `name ${name}`);
  for (const name of golden.agentNames.invalid) assert.equal(isValidAgentProfileName(expand(name)), false, `name ${name}`);
});
