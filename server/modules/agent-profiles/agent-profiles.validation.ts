import path from 'node:path';

import {
  AppError, assertValidProfileId, extractPlaceholderKeys, RESERVED_PARAM_KEYS,
} from '@/shared/utils.js';
import type {
  AgentProfileKind,
  AgentProfileMemoryScope,
  AgentProfileParam,
  AgentProfileTemplateInput,
  AgentProfileValues,
} from '@/shared/types.js';

/** Lower-case letters and digits separated by single hyphens: template slugs and memory block names. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PARAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FAMILIES = ['orchestrator', 'worker'];
const PARAM_TYPES = ['text', 'dir', 'file', 'url'];
const MEMORY_SCOPES = ['project', 'user', 'local'];
const MAX_VALUE_CHARS = 8000;
const BLOCK_MODES = ['read-only', 'writable'];

export type Obj = Record<string, unknown>;

/** A 400 `INVALID_PROFILE_INPUT`. Consumed by: this file, agent-profiles.blocks.validation.ts. */
export const invalid = (message: string): AppError =>
  new AppError(message, { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });

/** Consumed by: this file, agent-profiles.blocks.validation.ts. */
export function asObject(value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${what} must be an object`);
  return value as Obj;
}

/** Consumed by: this file, agent-profiles.blocks.validation.ts. */
export function text(source: Obj, key: string, options: { max: number; required?: boolean }): string {
  const value = source[key];
  if (value === undefined || value === null) {
    if (options.required) throw invalid(`${key} is required`);
    return '';
  }
  if (typeof value !== 'string') throw invalid(`${key} must be a string`);
  if (value.length > options.max) throw invalid(`${key} is longer than ${options.max} characters`);
  if (options.required && !value.trim()) throw invalid(`${key} is required`);
  return value;
}

function flag(source: Obj, key: string, fallback: boolean): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`);
  return value;
}

/** Consumed by: this file, agent-profiles.blocks.validation.ts. */
export function oneOf<T extends string>(source: Obj, key: string, allowed: readonly string[], fallback?: T): T {
  const value = source[key] ?? fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid(`${key} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function stringList(source: Obj, key: string, limits = { items: 100, length: 200 }): string[] | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > limits.items || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > limits.length)) {
    throw invalid(`${key} must be a list of at most ${limits.items} non-empty strings`);
  }
  return [...new Set(value.map((item: string) => item.trim()))];
}

/** Device names Windows reserves in every folder (`con.md` is one too), so a file can never carry them. */
const RESERVED_DEVICE_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Whether `name` is a Windows reserved device name (con, prn, aux, nul, com1-9, lpt1-9, any case). A template
 * slug becomes a file name, so these are refused wherever a slug is accepted or turned into a path.
 * Consumed by: slugOf below, agent-profiles.generator.ts (planning).
 */
export const isReservedDeviceName = (name: string): boolean => RESERVED_DEVICE_NAME_PATTERN.test(name);

function slugOf(source: Obj): string {
  const slug = text(source, 'slug', { max: 40, required: true });
  if (!SLUG_PATTERN.test(slug)) throw invalid('slug must be lower-case letters and digits separated by single hyphens');
  if (isReservedDeviceName(slug)) throw invalid(`slug "${slug}" is a reserved system name; choose another`);
  return slug;
}

function valuesOf(source: Obj, key = 'values'): AgentProfileValues {
  const raw = source[key] ?? {};
  const entries = Object.entries(asObject(raw, key));
  if (entries.length > 50) throw invalid(`${key} has more than 50 entries`);
  const values: AgentProfileValues = {};
  for (const [name, value] of entries) {
    if (!PARAM_KEY_PATTERN.test(name)) throw invalid(`${key}: "${name}" is not a valid parameter key`);
    if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) throw invalid(`${key}.${name} must be a string of at most ${MAX_VALUE_CHARS} characters`);
    values[name] = value;
  }
  return values;
}

function paramsOf(source: Obj): AgentProfileParam[] {
  const raw = source.params ?? [];
  if (!Array.isArray(raw) || raw.length > 30) throw invalid('params must be a list of at most 30 parameters');
  const seen = new Set<string>();
  return raw.map((entry) => {
    const param = asObject(entry, 'a parameter');
    const key = text(param, 'key', { max: 40, required: true });
    if (!PARAM_KEY_PATTERN.test(key)) throw invalid(`parameter key "${key}" must start with a letter and use letters, digits, _`);
    if (RESERVED_PARAM_KEYS.includes(key)) throw invalid(`parameter key "${key}" is reserved (filled from the project)`);
    if (seen.has(key)) throw invalid(`parameter key "${key}" is used twice`);
    seen.add(key);
    const parsed: AgentProfileParam = {
      key,
      type: oneOf(param, 'type', PARAM_TYPES, 'text'),
      title: text(param, 'title', { max: 80 }).trim() || key,
      description: text(param, 'description', { max: 500 }),
      required: flag(param, 'required', false),
    };
    if (param.default !== undefined && param.default !== null) parsed.default = text(param, 'default', { max: MAX_VALUE_CHARS });
    return parsed;
  });
}

/**
 * Validates and normalizes the body of a template create/update (unknown fields are
 * dropped). Every `{{key}}` in the instructions must be a declared parameter or a
 * reserved project key.
 * Consumed by: agent-profiles.service.ts.
 */
export function parseTemplateInput(body: unknown): AgentProfileTemplateInput {
  const source = asObject(body, 'template');
  const instructions = text(source, 'instructions', { max: 20000, required: true });
  const params = paramsOf(source);
  const allowedKeys = new Set([...params.map((param) => param.key), ...RESERVED_PARAM_KEYS]);
  const unknown = extractPlaceholderKeys(instructions).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw invalid(`instructions use {{${unknown.join('}}, {{')}}} which is not a declared parameter`);
  const bindings = source.bindings === undefined ? {} : asObject(source.bindings, 'bindings');
  const template: AgentProfileTemplateInput = {
    slug: slugOf(source),
    family: oneOf(source, 'family', FAMILIES),
    name: text(source, 'name', { max: 80, required: true }).trim(),
    description: text(source, 'description', { max: 1000 }).trim(),
    instructions,
    params,
    bindings: { project: flag(bindings, 'project', true), knowledge: flag(bindings, 'knowledge', false) },
  };
  const lists = { tools: stringList(source, 'tools'), disallowedTools: stringList(source, 'disallowedTools'), mcpServers: stringList(source, 'mcpServers'), skills: stringList(source, 'skills') };
  for (const [key, list] of Object.entries(lists)) if (list) (template as Obj)[key] = list;
  const model = text(source, 'model', { max: 100 }).trim();
  if (model) template.model = model;
  // Optional agent memory scope; an empty value means "off", like an absent field.
  if (source.memory !== undefined && source.memory !== null && source.memory !== '') {
    template.memory = oneOf<AgentProfileMemoryScope>(source, 'memory', MEMORY_SCOPES);
  }
  // Stored only when on: an absent field means "off", so older files and `false` look the same.
  if (flag(source, 'usesBlocks', false)) template.usesBlocks = true;
  // Dropdown heading; an empty value means "no group" (the dropdown's "System"), like an absent field.
  const group = text(source, 'group', { max: 40 }).trim();
  if (group) template.group = group;
  return template;
}

/**
 * Reads a project folder given by a request (body field or query string): absent, null or
 * blank means "no folder" (the global scope, null); anything else must be an absolute path
 * without NUL characters. Whether the folder exists is checked by the service that uses it.
 * Consumed by: agent-profiles.service.ts, claude-agents.service.ts.
 */
export function parseDirectory(value: unknown, field = 'directory'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const directory = value.trim();
  if (!directory) return null;
  if (directory.length > 500 || directory.includes('\0') || !path.isAbsolute(directory)) throw invalid(`${field} must be an absolute path`);
  return directory;
}

/**
 * Reads the sidebar project id of a scope-options request (query string): a non-empty string of at most
 * 200 characters. Whether a project has that id is checked by the service (404).
 * Consumed by: agent-profiles.service.ts.
 */
export function parseProjectId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new AppError('projectId is required (the id of a sidebar project).', { code: 'PROJECT_ID_REQUIRED', statusCode: 400 });
  }
  return value.trim();
}

/** What the Generate preview and apply requests carry, validated. */
export type ParsedGenerateRequest = {
  directory: string | null;
  projectName: string | null;
  templateIds: string[];
  values: AgentProfileValues;
};

/**
 * Validates the body of a Generate preview/apply: optional absolute `directory` (null = global
 * scope), optional `projectName`, 1-50 distinct `templateIds` and the `values` map (<= 50 entries).
 * Consumed by: agent-profiles.service.ts.
 */
export function parseGenerateRequest(body: unknown): ParsedGenerateRequest {
  const source = asObject(body, 'request body');
  return {
    directory: parseDirectory(source.directory),
    projectName: text(source, 'projectName', { max: 80 }).trim() || null,
    templateIds: parseTemplateIds(source),
    values: valuesOf(source),
  };
}

/**
 * Reads the `rev` a PUT must carry (the revision the client loaded).
 * Consumed by: agent-profiles.service.ts, claude-agents.service.ts.
 */
export function parseExpectedRev(body: unknown): number {
  const rev = asObject(body, 'request body').rev;
  if (!Number.isInteger(rev) || (rev as number) < 0) throw invalid('rev is required (the revision you loaded)');
  return rev as number;
}

/**
 * Reads the template ids of a bulk-generate request: 1-50 distinct valid ids.
 * Consumed by: agent-profiles.service.ts.
 */
export function parseTemplateIds(body: unknown): string[] {
  const ids = asObject(body, 'request body').templateIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) throw invalid('templateIds must be a list of 1-50 template ids');
  for (const id of ids) assertValidProfileId(id);
  return [...new Set(ids as string[])];
}

/**
 * Reads the name list of a hide-Claude-agents request (trimmed, de-duplicated).
 * Consumed by: claude-agents.service.ts.
 */
export function parseHiddenNames(body: unknown): string[] {
  return stringList(asObject(body, 'request body'), 'names', { items: 200, length: 100 }) ?? [];
}

/** Structural check of a memory block file (the part of `storedShapeProblem` for the `memory-blocks` kind). */
function memoryBlockShapeProblem(record: Obj): string | null {
  for (const key of ['name', 'description', 'content']) if (typeof record[key] !== 'string') return `${key} is not a string`;
  if (!SLUG_PATTERN.test(record.name as string)) return 'name is invalid';
  if (!BLOCK_MODES.includes(record.mode as string)) return 'mode is invalid';
  if (!Number.isInteger(record.maxChars) || (record.maxChars as number) < 1) return 'maxChars is invalid';
  const scope = record.scope as Obj | null | undefined;
  if (typeof scope !== 'object' || scope === null) return 'scope is not an object';
  if (scope.kind !== 'global' && !(scope.kind === 'project' && typeof scope.directory === 'string' && scope.directory)) return 'scope is invalid';
  const writer = record.lastWriter;
  if (writer !== null && writer !== 'user' && !(typeof writer === 'string' && writer.startsWith('agent:'))) return 'lastWriter is invalid';
  return null;
}

/**
 * Structural check of a record read from disk; returns a reason or null. Keeps a
 * hand-edited or half-migrated file from reaching code that assumes these fields.
 * Consumed by: agent-profiles.module.ts (given to the store).
 */
export function storedShapeProblem(kind: AgentProfileKind, value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const record = value as Obj;
  if (kind === 'memory-blocks') return memoryBlockShapeProblem(record);
  const strings = (...keys: string[]): string | null => {
    const bad = keys.find((key) => typeof record[key] !== 'string');
    return bad ? `${bad} is not a string` : null;
  };
  const objects = (...keys: string[]): string | null => {
    const bad = keys.find((key) => typeof record[key] !== 'object' || record[key] === null || Array.isArray(record[key]));
    return bad ? `${bad} is not an object` : null;
  };
  if (!FAMILIES.includes(record.family as string)) return 'family is invalid';
  if (!Array.isArray(record.params)) return 'params is not a list';
  // `isDefaultOrchestrator` / `origin` of files written by older versions are deliberately not checked: they are ignored.
  if (record.memory !== undefined && !MEMORY_SCOPES.includes(record.memory as string)) return 'memory is invalid';
  if (record.usesBlocks !== undefined && typeof record.usesBlocks !== 'boolean') return 'usesBlocks is not true or false';
  if (record.group !== undefined && typeof record.group !== 'string') return 'group is not a string';
  const notStrings = strings('slug', 'name', 'description', 'instructions');
  if (notStrings) return notStrings;
  // The slug becomes a file name and the marker only reads `[a-z0-9-]` slugs, so a hand-edited slug outside the
  // create/update rule would write a file Generate could never recognise again.
  if (!SLUG_PATTERN.test(record.slug as string) || isReservedDeviceName(record.slug as string)) return 'slug is invalid';
  return objects('bindings');
}
