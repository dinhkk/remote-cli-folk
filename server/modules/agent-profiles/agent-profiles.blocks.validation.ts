import type { MemoryBlockInput, MemoryBlockMode, MemoryBlockScope } from '@/shared/types.js';

import {
  SLUG_PATTERN, asObject, invalid, oneOf, text, type Obj,
} from './agent-profiles.validation.js';

/** At most this many blocks exist in total (all scopes). */
export const MAX_MEMORY_BLOCKS = 50;
/** `maxChars` of a block created without one. */
export const DEFAULT_BLOCK_MAX_CHARS = 2000;
/** Hard cap of `maxChars`: no block can hold more, whatever the request says. */
export const HARD_MAX_BLOCK_CHARS = 20000;

const BLOCK_MODES = ['read-only', 'writable'];
const MAX_BLOCK_NAME_CHARS = 40;

/**
 * Whether `name` is a valid block name (1-40 chars, lower-case letters and digits separated by single hyphens).
 * Consumed by: parseBlockInput below, agent-profiles.blocks.service.ts (agent tool calls).
 */
export const isValidBlockName = (name: unknown): name is string =>
  typeof name === 'string' && name.length > 0 && name.length <= MAX_BLOCK_NAME_CHARS && SLUG_PATTERN.test(name);

/** Reads the `expectedRev` an update must carry (the revision the editor loaded). */
export function parseExpectedBlockRev(body: unknown): number {
  const rev = asObject(body, 'memory block').expectedRev;
  if (!Number.isInteger(rev) || (rev as number) < 0) throw invalid('expectedRev is required (the revision you loaded)');
  return rev as number;
}

/**
 * Scope of a request: `{kind:'global'}` or `{kind:'project'}`. A project block is one definition with a content file
 * per folder, so a folder in the scope is refused (400) instead of silently ignored.
 */
function scopeOf(source: Obj): MemoryBlockScope {
  const scope = asObject(source.scope, 'scope');
  const kind = oneOf<'global' | 'project'>(scope, 'kind', ['global', 'project']);
  if (scope.directory !== undefined) {
    throw invalid('scope.directory is not accepted: a project block has content per folder; add folders with the contents endpoint');
  }
  return { kind };
}

/**
 * Validates and normalizes the body of a block create/update (unknown fields are dropped): a slug `name`, a
 * `description`, `mode`, `scope`, `content` and `maxChars` (default 2000, at most 20000; a global block's `content`
 * must fit). A project block holds no content in its definition: `content` is ignored and stored as ''.
 * Consumed by: agent-profiles.blocks.service.ts.
 */
export function parseBlockInput(body: unknown, options: { requireContent?: boolean } = {}): MemoryBlockInput {
  const source = asObject(body, 'memory block');
  const scope = scopeOf(source);
  // An update replaces the whole block: a body that forgot `content` must not silently empty it.
  if (scope.kind === 'global' && options.requireContent && typeof source.content !== 'string') throw invalid('content is required');
  const name = text(source, 'name', { max: MAX_BLOCK_NAME_CHARS, required: true });
  if (!isValidBlockName(name)) throw invalid('name must be lower-case letters and digits separated by single hyphens');
  const rawMaxChars = source.maxChars ?? DEFAULT_BLOCK_MAX_CHARS;
  if (!Number.isInteger(rawMaxChars) || (rawMaxChars as number) < 1 || (rawMaxChars as number) > HARD_MAX_BLOCK_CHARS) {
    throw invalid(`maxChars must be a whole number from 1 to ${HARD_MAX_BLOCK_CHARS}`);
  }
  const maxChars = rawMaxChars as number;
  const content = scope.kind === 'global' ? text(source, 'content', { max: HARD_MAX_BLOCK_CHARS }) : '';
  if (content.length > maxChars) throw invalid(`content is longer than maxChars (${maxChars} characters)`);
  return {
    name,
    description: text(source, 'description', { max: 500 }).trim(),
    mode: oneOf<MemoryBlockMode>(source, 'mode', BLOCK_MODES),
    scope,
    content,
    maxChars,
  };
}
