#!/usr/bin/env node
// Checks the Remote work documentation (plain Node, no dependencies).
//
//   node scripts/check-remote-docs.mjs [repoRoot] [--json]
//
// Without arguments the repo root is resolved from this file: <root>/project/cloud-cli-remote/claudecodeui/scripts
// is four levels below it. Exit code 1 when any problem is found.
//
// Checks: required files exist; every required keyword/heading is present; every CLOUDCLI_REMOTE_* variable used by
// non-test server code or relay/src is documented in docs/deployment-guide.md; the defaults the guide's table gives
// for the quota, expiry, suspension and audit-retention variables equal the constants in the code; relative links
// and #anchors resolve (GitHub heading slugs); each doc stays under MAX_DOC_LINES lines. It is a structure and
// env-name guard (plus those defaults), not a check of every sentence against the code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEPLOYMENT_GUIDE,
  DOCUMENTED_DEFAULTS,
  MAX_DOC_LINES,
  REQUIRED_CONTENT,
  REQUIRED_FILES,
} from './check-remote-docs-rules.mjs';

const FORK_RELATIVE_PATH = path.join('project', 'cloud-cli-remote', 'claudecodeui');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'tests', 'dist', 'dist-server', '.wrangler', '.git']);
// A full variable name: the lookahead rejects prefixes such as `CLOUDCLI_REMOTE_REFUSED_UPLOAD_*` in comments.
const ENV_VAR_PATTERN = /CLOUDCLI_REMOTE_[A-Z0-9_]*[A-Z0-9](?![A-Z0-9_*{])/g;

const toPosix = (value) => value.split(path.sep).join('/');

/** Where a path of REQUIRED_FILES lives: `app:` prefix = inside the fork, otherwise relative to the repo root. */
const resolveRequired = (root, appRoot, file) =>
  file.startsWith('app:') ? path.join(appRoot, file.slice(4)) : path.join(root, file);

const readText = (file) => fs.readFileSync(file, 'utf8');

const withoutFences = (text) => text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '');

/** Removes fenced code blocks and inline code so link-looking text in examples is ignored. */
const withoutCode = (text) => withoutFences(text).replace(/`[^`\n]*`/g, '');

/** GitHub heading slugs of a markdown document, in order, with -1/-2 suffixes for duplicates. */
const headingSlugs = (text) => {
  const seen = new Map();
  const slugs = new Set();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const plain = match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const base = plain.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
};

const walk = (directory, accept, found = []) => {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full, accept, found);
    } else if (accept(entry.name)) {
      found.push(full);
    }
  }
  return found;
};

/** CLOUDCLI_REMOTE_* names used by production server code and the relay source. */
export const collectEnvVariables = (appRoot) => {
  const isSource = (name) => /\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.[a-z]+$/.test(name);
  const files = [...walk(path.join(appRoot, 'server'), isSource), ...walk(path.join(appRoot, 'relay', 'src'), isSource)];
  const found = new Map();
  for (const file of files) {
    for (const match of readText(file).matchAll(ENV_VAR_PATTERN)) {
      if (!found.has(match[0])) found.set(match[0], toPosix(path.relative(appRoot, file)));
    }
  }
  return found;
};

const mentions = (doc, name) => new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(doc);

const checkLinks = (docPath, text, label, problems) => {
  const own = headingSlugs(text);
  for (const match of withoutCode(text).matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [filePart, anchor] = target.split('#');
    const resolved = filePart ? path.resolve(path.dirname(docPath), decodeURIComponent(filePart)) : docPath;
    if (!fs.existsSync(resolved)) {
      problems.push(`${label}: broken link "${target}" (no such file)`);
      continue;
    }
    if (!anchor || !resolved.endsWith('.md')) continue;
    const slugs = resolved === docPath ? own : headingSlugs(readText(resolved));
    if (!slugs.has(decodeURIComponent(anchor).toLowerCase())) problems.push(`${label}: broken anchor "${target}"`);
  }
};

/** The default column of the guide's environment table row for `name` (`| \`NAME\` | default | ...`), or null when there is no such row. */
const documentedDefault = (guide, name) => {
  const row = new RegExp(`^\\|\\s*\`${name}\`\\s*\\|\\s*([^|]*?)\\s*\\|`, 'm').exec(guide);
  return row ? row[1] : null;
};

/** Compares the defaults the guide documents with the constants in the code (see DOCUMENTED_DEFAULTS). */
const checkDocumentedDefaults = (appRoot, guide, problems) => {
  for (const [name, [relative, pattern]] of Object.entries(DOCUMENTED_DEFAULTS)) {
    const source = path.join(appRoot, relative);
    if (!fs.existsSync(source)) continue;
    const inCode = pattern.exec(readText(source))?.[1];
    if (inCode === undefined) {
      problems.push(`${DEPLOYMENT_GUIDE}: cannot read the default of ${name} from ${relative} (the check's pattern no longer matches)`);
      continue;
    }
    const inGuide = documentedDefault(guide, name);
    if (inGuide === null) problems.push(`${DEPLOYMENT_GUIDE}: no environment table row for ${name}`);
    else if (inGuide.replace(/[`\s,_]/g, '') !== inCode) problems.push(`${DEPLOYMENT_GUIDE}: ${name} is documented with default "${inGuide}" but the code default is ${inCode}`);
  }
};

/**
 * Runs every check.
 * @param {{ root: string, appRoot?: string }} options `root` = repository root; `appRoot` defaults to the fork inside it.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkRemoteDocs({ root, appRoot = path.join(root, FORK_RELATIVE_PATH) }) {
  const problems = [];
  const texts = new Map();

  for (const file of REQUIRED_FILES) {
    const full = resolveRequired(root, appRoot, file);
    if (!fs.existsSync(full)) {
      problems.push(`missing required file: ${file.replace(/^app:/, '')}`);
      continue;
    }
    const text = readText(full);
    texts.set(file, text);
    const label = file.replace(/^app:/, '');
    const lines = text.split('\n').length;
    if (lines >= MAX_DOC_LINES) problems.push(`${label}: ${lines} lines, must be under ${MAX_DOC_LINES}`);
    checkLinks(full, text, label, problems);
  }

  for (const [file, requirement] of REQUIRED_CONTENT) {
    const text = texts.get(file);
    if (text !== undefined && !requirement.test(text)) {
      problems.push(`${file.replace(/^app:/, '')}: missing ${requirement.label}`);
    }
  }

  const guide = texts.get(DEPLOYMENT_GUIDE);
  if (guide !== undefined) {
    for (const [name, where] of collectEnvVariables(appRoot)) {
      if (!mentions(guide, name)) problems.push(`${DEPLOYMENT_GUIDE}: undocumented environment variable ${name} (used in ${where})`);
    }
    checkDocumentedDefaults(appRoot, guide, problems);
  }

  return { ok: problems.length === 0, problems };
}

const runCli = () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const [rootArgument] = args.filter((argument) => argument !== '--json');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = rootArgument ? path.resolve(rootArgument) : path.resolve(here, '..', '..', '..', '..');
  const result = checkRemoteDocs({ root });
  if (json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log('Remote docs OK');
  } else {
    console.error(`Remote docs: ${result.problems.length} problem(s)`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
  }
  process.exit(result.ok ? 0 : 1);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCli();
