/**
 * Static scan of the server's route registrations for the route inventory (AC-13). `server/index.ts` starts
 * listening on import, so the real Express app cannot be built in a test; the registrations are read from
 * source instead, strictly: every `router.<verb>(` / `app.<verb>(` call must either yield a literal route or be
 * reported as a problem, so a registration style this scanner does not understand turns the test red instead
 * of silently dropping a route.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<fork>/server`. */
export const SERVER_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const VERBS: readonly HttpVerb[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** One literal registration. `method` ALL = `router.all` / `router.use('/path', ...)`; `rest` = it serves everything below the path too. */
export type ScannedRegistration = { method: HttpVerb | 'ALL'; path: string; rest: boolean; file: string; line: number };
export type ScanProblem = { file: string; line: number; text: string };
export type ScanResult = { registrations: ScannedRegistration[]; problems: ScanProblem[]; calls: number };

/** Replaces comments with spaces (newlines kept), leaving string contents alone. Quote strings end at a newline. */
export const stripComments = (source: string): string => {
  let out = '';
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 1;
      } else if (char === quote || (char === '\n' && quote !== '`')) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop - 1;
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char;
      out += char;
    }
  }
  return out;
};

const CALL = /(?<![.\w$])(router|app)\s*\.\s*(get|post|put|patch|delete|all|options|head|use|route|param)\s*\(\s*/g;
/** First argument forms of `use(...)` that are middleware, not routes. */
const MIDDLEWARE_ARGUMENT = /^(\(|\.\.\.|remoteErrorHandler|targetPageCspMiddleware|mainPageSecurityHeaders|mainPageHeaders|cors\(|express\.(json|urlencoded|static)\()/;

/**
 * Scans one source file. `subRouterCall` is the one sub-router mount the scanner understands (the call text
 * `router.use(createProjectCloneRouter(` in projects.routes.ts); anything else that mounts a router is a problem.
 */
export function scanRouteSource(file: string, source: string, known: { subRouterCalls?: readonly string[] } = {}): ScanResult {
  const code = stripComments(source);
  const registrations: ScannedRegistration[] = [];
  const problems: ScanProblem[] = [];
  let calls = 0;
  for (const match of code.matchAll(CALL)) {
    calls += 1;
    const [, , verb] = match;
    const start = match.index + match[0].length;
    const line = code.slice(0, match.index).split('\n').length;
    const quote = code[start];
    const problem = (text: string): void => void problems.push({ file, line, text: `${match[1]}.${verb}(${code.slice(start, start + 40).split('\n')[0]}: ${text}` });
    if (verb === 'options' || verb === 'head' || verb === 'route' || verb === 'param') {
      problem(`\`${verb}\` registrations are not understood by the scanner`);
      continue;
    }
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      const argument = code.slice(start, start + 80);
      const isSubRouter = known.subRouterCalls?.some((call) => argument.startsWith(call));
      if (verb === 'use' && (MIDDLEWARE_ARGUMENT.test(argument) || isSubRouter)) continue;
      problem('the first argument is not a string literal (a router or route the scanner cannot read)');
      continue;
    }
    const end = code.indexOf(quote, start + 1);
    const literal = code.slice(start + 1, end);
    if (end === -1 || literal.includes('${') || /[()+?{}[\]|^$\\]/.test(literal)) {
      problem('the path is a template or a regular expression');
      continue;
    }
    registrations.push({
      method: verb === 'use' || verb === 'all' ? 'ALL' : (verb.toUpperCase() as HttpVerb),
      path: literal,
      rest: verb === 'use' || literal.includes('*'),
      file,
      line,
    });
  }
  problems.push(...findHiddenRegistrations(file, code));
  return { registrations, problems, calls };
}

/** A router created under any other name than `router`: `CALL` would never see its registrations. */
const ROUTER_DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g;
/** `<identifier>.<verb>('/...` : a route-looking registration on whatever receiver. */
const ANY_RECEIVER = /([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|route|use)\s*\(\s*['"`]\//g;
/** `...).<verb>('/...` : a second registration chained onto the first call. */
const CHAINED = /\)\s*\.\s*(get|post|put|patch|delete|all|route|use)\s*\(\s*['"`]\//g;

/**
 * Registrations `CALL` cannot see because of the receiver they are made on: a router under another name,
 * a path registered on any receiver other than `router` / `app`, a property receiver (`this.router.get`),
 * a chained call. They are reported as problems so the inventory fails instead of dropping the route.
 */
function findHiddenRegistrations(file: string, code: string): ScanProblem[] {
  const problems: ScanProblem[] = [];
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
  for (const match of code.matchAll(ROUTER_DECLARATION)) {
    if (match[1] === 'router') continue;
    problems.push({ file, line: lineOf(match.index), text: `router \`${match[1]}\` is declared under another name: the scanner only reads \`router.<verb>(\` calls` });
  }
  for (const match of code.matchAll(ANY_RECEIVER)) {
    const [, receiver, verb] = match;
    const property = code[match.index - 1] === '.';
    if ((receiver === 'router' || receiver === 'app') && !property) continue;
    const what = property ? `property receiver \`.${receiver}\`` : `receiver \`${receiver}\``;
    problems.push({ file, line: lineOf(match.index), text: `${receiver}.${verb}(...: registration on ${what}, which the scanner does not read (use \`router.${verb}(\` or \`app.${verb}(\`)` });
  }
  for (const match of code.matchAll(CHAINED)) {
    problems.push({ file, line: lineOf(match.index), text: `.${match[1]}(...: chained registration, the scanner reads only the first call of a chain` });
  }
  return problems;
}

export const readServerSource = (relative: string): string => readFileSync(path.join(SERVER_ROOT, relative), 'utf8');
