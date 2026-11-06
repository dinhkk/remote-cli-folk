/**
 * The route scanner behind the inventory is strict: a registration style it cannot read must be a reported
 * problem (never a silently dropped route). These cases pin the styles that would hide a route.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { scanRouteSource } from '../support/route-source-scanner.js';

const problemsOf = (source: string): string[] => scanRouteSource('synthetic.routes.ts', source).problems.map((problem) => problem.text);

test('plain `router.<verb>(literal)` registrations are read, with no problem', () => {
  const scan = scanRouteSource('synthetic.routes.ts', "const router = express.Router();\nrouter.get('/a', h);\nrouter.post('/b/:id', h);\nrouter.use('/c', sub);");
  assert.deepEqual(scan.problems, []);
  assert.deepEqual(scan.registrations.map((registration) => `${registration.method} ${registration.path}`), ['GET /a', 'POST /b/:id', 'ALL /c']);
});

test('a router held under another name is a problem (its registrations would be invisible to the scan)', () => {
  assert.match(problemsOf("const r = express.Router();\nr.get('/x', h);").join('\n'), /router `r`/);
  assert.match(problemsOf("const projectsRouter = Router();").join('\n'), /router `projectsRouter`/);
  assert.match(problemsOf("let api: express.Router = express.Router();").join('\n'), /router `api`/);
});

test('a registration on a receiver the scanner does not recognise is a problem', () => {
  assert.match(problemsOf("projectsRouter.post('/x', h);").join('\n'), /receiver `projectsRouter`/);
  assert.match(problemsOf("api.delete(`/y`, h);").join('\n'), /receiver `api`/);
  assert.match(problemsOf("subRouter.use('/z', h);").join('\n'), /receiver `subRouter`/);
});

test('a chained registration is a problem (only the first call of the chain is a `router.<verb>(`)', () => {
  assert.match(problemsOf("router.get('/a', h).post('/b', h);").join('\n'), /chained/);
  assert.match(problemsOf("router.use(mw).get('/a', h);").join('\n'), /chained/);
});

test('calls that are not route registrations are not reported (a lookup with a non-path argument, a call on a value)', () => {
  assert.deepEqual(problemsOf("const value = map.get('key');\nconst h = headers.get(name);\nrouter.get('/a', h);"), []);
});
