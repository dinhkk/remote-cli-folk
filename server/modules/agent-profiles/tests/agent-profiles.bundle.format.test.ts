import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '@/shared/utils.js';
import type { AgentBundle } from '@/shared/types.js';

import { parseBundleText, serializeBundle } from '../agent-profiles.bundle.format.js';

const bundle = (overrides: Partial<AgentBundle> = {}): AgentBundle => ({
  format: 'remotecli.agent-bundle',
  version: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  templates: [{
    slug: 'alpha', family: 'worker', name: 'Alpha', description: 'Does alpha.',
    instructions: 'Line one.\n  indented line\n\nLast line.\n', params: [], bindings: { project: true, knowledge: false },
  }],
  memoryBlocks: [{ name: 'beta', description: 'Beta notes', mode: 'writable', scope: { kind: 'global' }, maxChars: 2000, content: ' leading space\nsecond line\n' }],
  ...overrides,
});

const failure = (text: string): AppError => {
  try {
    parseBundleText(text);
  } catch (error) {
    assert.ok(error instanceof AppError, 'expected an AppError');
    return error;
  }
  throw new assert.AssertionError({ message: 'expected parseBundleText to throw' });
};

const details = (error: AppError) => error.details as { line?: number; column?: number; path?: string };

describe('agent bundle text format', () => {
  it('parses the same bundle from YAML and from JSON', () => {
    const value = bundle();
    const fromYaml = parseBundleText(serializeBundle(value, 'yaml')).bundle;
    const fromJson = parseBundleText(serializeBundle(value, 'json')).bundle;
    assert.deepEqual(fromYaml, value);
    assert.deepEqual(fromJson, value);
  });

  it('serializes YAML by default with the stable key order and readable block scalars', () => {
    const text = serializeBundle(bundle());
    const order = ['format:', 'version:', 'exportedAt:', 'templates:', 'memoryBlocks:'].map((key) => text.indexOf(`\n${key}`) + (key === 'format:' ? 1 : 0));
    assert.ok(text.startsWith('format:'), 'format comes first');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'keys keep the documented order');
    assert.match(text, /instructions: \|/, 'multi-line prompts are block scalars');
    assert.ok(!text.trim().startsWith('{'), 'not JSON');
  });

  it('round-trips awkward strings through YAML', () => {
    const awkward = [
      'plain', '', ' leading', 'trailing ', '\tTabbed', 'a\nb', 'a\n\nb\n\n', '  indented\nsecond', 'yes', 'null', '123', '1.5', '- not a list',
      'key: value', '# not a comment', '"quoted"', "it's", 'ünïcödé ✓', 'line\r\nwindows', '*star', '&amp', '| pipe', '> fold', 'x'.repeat(500),
    ];
    for (const value of awkward) {
      const original = bundle({ templates: [{ ...bundle().templates[0], instructions: value || 'x', description: value }] });
      const restored = parseBundleText(serializeBundle(original, 'yaml')).bundle;
      assert.deepEqual(restored, original, `round trip of ${JSON.stringify(value)}`);
    }
  });

  it('reports line and column of a YAML syntax error', () => {
    const error = failure('format: remotecli.agent-bundle\nversion: 1\ntemplates: [unclosed\nmemoryBlocks: []\n');
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.equal(error.statusCode, 400);
    assert.ok(typeof details(error).line === 'number' && details(error).line! >= 3, 'line');
    assert.ok(typeof details(error).column === 'number', 'column');
    assert.match(error.message, /line \d+/i);
  });

  it('reports the path and position of a value of the wrong type', () => {
    const error = failure('format: remotecli.agent-bundle\nversion: 1\ntemplates: nope\nmemoryBlocks: []\n');
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.equal(details(error).path, 'templates');
    assert.equal(details(error).line, 3);
  });

  it('rejects aliases and anchors (no expansion attacks)', () => {
    const bomb = 'format: remotecli.agent-bundle\nversion: 1\nx: &a [1, 2]\ntemplates: *a\nmemoryBlocks: []\n';
    const error = failure(bomb);
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.match(error.message, /alias|anchor/i);
    assert.equal(details(error).line, 3);
    assert.equal(failure('format: remotecli.agent-bundle\nversion: 1\nx: &only 1\ntemplates: []\n').code, 'BUNDLE_INVALID');
  });

  it('rejects a duplicate key', () => {
    const error = failure('format: remotecli.agent-bundle\nversion: 1\nversion: 1\ntemplates: []\n');
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.match(error.message, /duplicate|unique/i);
  });

  it('rejects unknown format and version, and a missing or non-object document', () => {
    assert.equal(failure('format: something-else\nversion: 1\n').code, 'BUNDLE_INVALID');
    assert.equal(failure('format: remotecli.agent-bundle\nversion: 2\n').code, 'BUNDLE_VERSION_UNSUPPORTED');
    assert.equal(failure('format: remotecli.agent-bundle\n').code, 'BUNDLE_INVALID');
    assert.equal(failure('').code, 'BUNDLE_INVALID');
    assert.equal(failure('- a\n- b\n').code, 'BUNDLE_INVALID');
    assert.equal(failure('---\nformat: remotecli.agent-bundle\nversion: 1\n---\nformat: x\n').code, 'BUNDLE_INVALID');
  });

  it('accepts a bundle that omits an empty list', () => {
    const parsed = parseBundleText('format: remotecli.agent-bundle\nversion: 1\ntemplates: []\n').bundle;
    assert.deepEqual(parsed.memoryBlocks, []);
    assert.equal(parsed.exportedAt, '');
  });

  it('rejects nesting deeper than 8 levels', () => {
    let deep: unknown = 'leaf';
    for (let level = 0; level < 12; level += 1) deep = { child: deep };
    const error = failure(JSON.stringify({ format: 'remotecli.agent-bundle', version: 1, templates: [], memoryBlocks: [], extra: deep }));
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.match(error.message, /deep|nest/i);
  });

  it('rejects more than 500 folder entries in one bundle', () => {
    const contents = Array.from({ length: 201 }, (_, index) => ({ directory: `/work/${index}`, content: 'x' }));
    const block = (name: string) => ({ name, description: '', mode: 'writable', scope: { kind: 'project' }, maxChars: 100, contents });
    const text = JSON.stringify({ format: 'remotecli.agent-bundle', version: 1, templates: [], memoryBlocks: [block('a'), block('b'), block('c')] });
    const error = failure(text);
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.match(error.message, /500/);
  });

  it('locates a path in the source text', () => {
    const text = 'format: remotecli.agent-bundle\nversion: 1\ntemplates:\n  - slug: a\n  - slug: b\n    tools: wrong\nmemoryBlocks: []\n';
    const parsed = parseBundleText(text);
    assert.deepEqual(parsed.locate('templates[1].tools'), { line: 6, column: 12 });
    const closest = parsed.locate('templates[7].tools');
    assert.ok(closest !== null && closest.line < 6, 'falls back to the closest existing ancestor');
  });

  it('a JSON syntax error is reported with a position as well', () => {
    const error = failure('{"format": "remotecli.agent-bundle" "version": 1}');
    assert.equal(error.code, 'BUNDLE_INVALID');
    assert.equal(details(error).line, 1);
  });
});
