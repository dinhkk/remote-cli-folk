import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { RemoteTargetRejection } from '@/shared/types.js';

import { canonicalizeRequestTarget } from '../../policy/path-canonicalizer.js';
import { createSeededRandom } from '../support/seeded-random.js';

/** Accepted targets: input -> canonical path + query exactly as it would be forwarded to the Host. */
const ACCEPTED: Array<[string, string]> = [
  ['/api/projects', '/api/projects'],
  ['/API/Projects', '/API/Projects'], // case is preserved for forwarding; only matching is case-insensitive
  ['/api//projects', '/api/projects'],
  ['/api///projects//', '/api/projects'],
  ['/api/./projects', '/api/projects'],
  ['/api/x/../projects', '/api/projects'],
  ['/api/x/./y/../z', '/api/x/z'],
  ['/api/projects/', '/api/projects'],
  ['/', '/'],
  ['/./', '/'],
  ['/api/%61uth', '/api/auth'], // decoded exactly once: the allow-list then sees the real name
  ['/api/%41uth', '/api/Auth'],
  ['/api/assets/files/Report.PDF', '/api/assets/files/Report.PDF'],
  ['/api/assets/files/my%20file.pdf', '/api/assets/files/my%20file.pdf'],
  ['/api/assets/files/b%C3%A1o-c%C3%A1o.pdf', '/api/assets/files/b%C3%A1o-c%C3%A1o.pdf'],
  ['/api/assets/files/b%c3%a1o.pdf', '/api/assets/files/b%C3%A1o.pdf'], // hex digits normalised
  ['/api/%E4%BD%A0%E5%A5%BD', '/api/%E4%BD%A0%E5%A5%BD'],
  ['/api/assets/files/100%25.txt', '/api/assets/files/100%25.txt'], // a lone literal percent is fine
  ['/api/a%3Ab', '/api/a:b'],
  ['/api/a%2Bb', '/api/a+b'],
  ['/api/a:b@c+d,e=f', '/api/a:b@c+d,e=f'],
  ['/api/%7Efoo', '/api/~foo'],
  ['/api/.hidden', '/api/.hidden'],
  ['/api/..hidden', '/api/..hidden'],
  ['/api/a..b', '/api/a..b'],
  ['/api/projects?x=1', '/api/projects?x=1'],
  ['/api/projects?token=abc', '/api/projects'],
  ['/api/projects?a=1&token=abc&b=2', '/api/projects?a=1&b=2'],
  ['/api/projects?TOKEN=abc', '/api/projects'],
  ['/api/projects?Token=abc&x=1', '/api/projects?x=1'],
  ['/api/projects?tok%65n=abc', '/api/projects'], // qs decodes the key before reading req.query.token
  ['/api/projects?token[]=a&token[x]=b&q=1', '/api/projects?q=1'],
  ['/api/projects?token', '/api/projects'],
  ['/api/projects?token.x=1&y=2', '/api/projects?y=2'],
  // Conservative: any key that mentions `token` once decoded is dropped, not only the ones qs maps to `req.query.token`.
  ['/api/projects?tokenizer=1', '/api/projects'],
  ['/api/projects?access_token=1&y=2', '/api/projects?y=2'],
  ['/api/projects?a[token]=1&y=2', '/api/projects?y=2'],
  // qs turns a key whose ROOT is a bracket group into that name: these all populate `req.query.token`.
  ['/api/projects?[token]=a', '/api/projects'],
  ['/api/projects?%5Btoken%5D=a', '/api/projects'],
  ['/api/projects?%5btoken%5d=a', '/api/projects'],
  ['/api/projects?%5Btoken%5d=a', '/api/projects'], // mixed escape case
  ['/api/projects?[token][x]=a', '/api/projects'],
  ['/api/projects?%5Btoken%5D%5Bx%5D=a', '/api/projects'],
  ['/api/projects?%5Btok%65n%5D=a', '/api/projects'], // mixed encodings inside one key
  ['/api/projects?[token]', '/api/projects'], // key without a value
  ['/api/projects?%5Btoken%5D', '/api/projects'],
  ['/api/projects?[token]=', '/api/projects'],
  ['/api/projects?+token=a', '/api/projects'], // `+` is a space for qs, still mentions token
  ['/api/projects?TOKEN=a', '/api/projects'],
  ['/api/projects?[TOKEN]=a', '/api/projects'],
  ['/api/projects?a=1&token=b&c=2', '/api/projects?a=1&c=2'],
  ['/api/projects?token=1&token=2&x=1&token=3', '/api/projects?x=1'], // duplicates
  ['/api/projects?x=1&[token]=a&%5Btoken%5D=b&y=2', '/api/projects?x=1&y=2'],
  ['/api/projects?token&a=1', '/api/projects?a=1'],
  ['/api/projects?a=token&b=%74oken', '/api/projects?a=token&b=%74oken'], // a VALUE that says token is not a key
  ['/api/projects?a=1]=token', '/api/projects?a=1]=token'], // qs reads the key up to `]=`: `a=1]`, no token in it
  ['/api/projects?[to=ken]=x', '/api/projects?[to=ken]=x'], // key `[to=ken]`: no token in it
  ['/api/projects?', '/api/projects'],
  ['/api/projects?a=1&&b=2', '/api/projects?a=1&b=2'],
  ['/api/projects?a=b?token=1', '/api/projects?a=b?token=1'], // the value of `a`, not a token key
  ['/api/projects?a=1%26token=x', '/api/projects?a=1%26token=x'], // an encoded & does not start a new key
  ['/api/file-tree/projects/p1/file?path=%2Fetc%2Fhosts', '/api/file-tree/projects/p1/file?path=%2Fetc%2Fhosts'], // the query is passed on undecoded
  ['/ws?token=abc', '/ws'],
  ['/a'.repeat(30), '/a'.repeat(30)],
  [`/${'a'.repeat(4095)}`, `/${'a'.repeat(4095)}`],
];

/** Refused targets: input -> why. Every one of these must never reach the Host. */
const REJECTED: Array<[string, RemoteTargetRejection]> = [
  ['', 'not-origin-form'],
  ['api/projects', 'not-origin-form'],
  ['http://x/api', 'not-origin-form'],
  ['https://evil.com/api/projects', 'not-origin-form'],
  ['HTTP://x/api', 'not-origin-form'],
  ['*', 'not-origin-form'],
  ['//evil.com/api', 'protocol-relative'],
  ['//api//projects', 'protocol-relative'],
  ['///', 'protocol-relative'],
  ['//', 'protocol-relative'],
  ['/\\evil.com', 'backslash'],
  ['/api\\projects', 'backslash'],
  ['/api/%5cprojects', 'encoded-separator'],
  ['/api/%5Cprojects', 'encoded-separator'],
  ['/api/%2fprojects', 'encoded-separator'],
  ['/api/%2Fauth', 'encoded-separator'],
  ['/api/%00', 'control-character'],
  ['/api/a%00b', 'control-character'],
  ['/api/auth;x=1', 'path-parameter'],
  ['/api/auth%3Bx=1', 'path-parameter'],
  ['/api/%3b', 'path-parameter'],
  ['/api/%2e%2e/auth', 'encoded-dot-segment'],
  ['/api/%2E%2E/auth', 'encoded-dot-segment'],
  ['/api/%2e/auth', 'encoded-dot-segment'],
  ['/api/.%2e/auth', 'encoded-dot-segment'],
  ['/api/%2e./auth', 'encoded-dot-segment'],
  ['/api/%252e%252e/auth', 'double-encoding'],
  ['/api/%252f', 'double-encoding'],
  ['/api/%25252e', 'double-encoding'],
  ['/api/%2541', 'double-encoding'],
  ['/api/%zz', 'bad-percent-encoding'],
  ['/api/%', 'bad-percent-encoding'],
  ['/api/%4', 'bad-percent-encoding'],
  ['/api/%G1', 'bad-percent-encoding'],
  ['/api/a%', 'bad-percent-encoding'],
  ['/api/%C3', 'invalid-utf8'],
  ['/api/%FF', 'invalid-utf8'],
  ['/api/%C0%AF', 'invalid-utf8'], // overlong "/"
  ['/api/%ED%A0%80', 'invalid-utf8'], // UTF-8 encoded surrogate
  ['/../api', 'traversal-above-root'],
  ['/api/../../x', 'traversal-above-root'],
  ['/..', 'traversal-above-root'],
  ['/api/projects.', 'trailing-dot'],
  ['/api/auth./x', 'trailing-dot'],
  ['/api/projects%20', 'trailing-dot'],
  ['/api/...', 'trailing-dot'],
  ['/api/projects name', 'illegal-character'],
  ['/api/\tx', 'illegal-character'],
  ['/api/\nfoo', 'illegal-character'],
  ['/api/x\r\nHost: evil', 'illegal-character'],
  ['/api/é', 'illegal-character'],
  ['/api/\u0000', 'illegal-character'],
  ['/api/\u007f', 'illegal-character'],
  ['/api/x#frag', 'illegal-character'],
  ['/api/%E2%80%AE', 'control-character'], // right-to-left override
  ['/api/%E2%80%8B', 'control-character'], // zero width space
  ['/api/%EF%BB%BF', 'control-character'], // BOM
  ['/api/%0D%0A', 'control-character'],
  ['/api/%7F', 'control-character'],
  ['/api/%C2%85', 'control-character'],
  ['/api/%E2%80%A8', 'control-character'], // line separator
  [`/${'a'.repeat(4096)}`, 'too-long'],
  [`/${'a'.repeat(5000)}`, 'too-long'],
  [`/x?${'a'.repeat(8200)}`, 'too-long'],
  [`/${'a/'.repeat(65)}`, 'too-long'],
  ['/api/x?a=%00', 'bad-query'],
  ['/api/x?%00=1', 'bad-query'],
  // A key still holding a `%hh` after the single decode was encoded twice: refused, like the path.
  ['/api/x?%255Btoken%255D=a', 'bad-query'],
  ['/api/x?%2574oken=a', 'bad-query'],
  ['/api/x?a%2525=1', 'bad-query'],
  ['/api/x?a b', 'illegal-character'],
  ['/api/x?é', 'illegal-character'],
  ['/api/x?a=1#f', 'illegal-character'],
  ['/api/x?a=\r\n', 'illegal-character'],
];

test('the table has at least 60 cases', () => {
  assert.ok(ACCEPTED.length + REJECTED.length >= 60, `${ACCEPTED.length + REJECTED.length} cases`);
});

for (const [input, expected] of ACCEPTED) {
  test(`accepts ${JSON.stringify(input.length > 80 ? `${input.slice(0, 40)}...(${input.length})` : input)}`, () => {
    const result = canonicalizeRequestTarget(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.canonical.path + result.canonical.query, expected);
    // Canonicalizing a canonical form changes nothing (the forwarded form is what the Host will route).
    const again = canonicalizeRequestTarget(expected);
    assert.equal(again.ok && again.canonical.path + again.canonical.query, expected);
  });
}

for (const [input, reason] of REJECTED) {
  test(`refuses ${JSON.stringify(input.length > 80 ? `${input.slice(0, 40)}...(${input.length})` : input)} as ${reason}`, () => {
    assert.deepEqual(canonicalizeRequestTarget(input), { ok: false, reason });
  });
}

test('segments are the decoded segments with their original case, and match the forwarded path', () => {
  const result = canonicalizeRequestTarget('/API/assets/files/b%C3%A1o%20Cao.PDF?token=x&k=1');
  assert.ok(result.ok);
  assert.deepEqual(result.canonical.segments, ['API', 'assets', 'files', 'báo Cao.PDF']);
  assert.equal(result.canonical.path, '/API/assets/files/b%C3%A1o%20Cao.PDF');
  assert.equal(result.canonical.query, '?k=1');
});

test('the root has no segments', () => {
  const result = canonicalizeRequestTarget('/');
  assert.ok(result.ok);
  assert.deepEqual(result.canonical.segments, []);
  assert.equal(result.canonical.path, '/');
});

test('non-string input is refused instead of throwing', () => {
  for (const value of [undefined, null, 5, {}, [], Buffer.from('/api')]) {
    assert.deepEqual(canonicalizeRequestTarget(value as unknown as string), { ok: false, reason: 'not-origin-form' });
  }
});

/**
 * Express's default query parser (`qs.parse(str, { allowPrototypes: true })`, resolved through express
 * itself: the test must not share a blind spot with a re-implementation of it).
 */
const expressQuery = ((): ((query: string) => Record<string, unknown>) => {
  const fromExpress = createRequire(createRequire(import.meta.url).resolve('express'));
  const qs = fromExpress('qs') as { parse(input: string, options: { allowPrototypes: boolean }): Record<string, unknown> };
  return (query) => qs.parse(query.replace(/^\?/, ''), { allowPrototypes: true });
})();

/** Asserts what the stock authentication would read (`req.query.token`) is absent for the forwarded query. */
const assertNoTokenForExpress = (query: string, context: string): void => {
  const parsed = expressQuery(query);
  assert.equal(parsed.token, undefined, `req.query.token would be populated for ${context}: ${query}`);
  assert.ok(!Object.hasOwn(parsed, 'token'), `req.query has a token key for ${context}: ${query}`);
};

test('real qs sanity: the spellings the review found DO populate req.query.token when forwarded unfiltered', () => {
  for (const raw of ['[token]=a', '%5Btoken%5D=a', '%5btoken%5d=a', '[token][x]=a', 'token=a', 'token[]=a', 'token[x]=a', 'tok%65n=a', 'TOKEN=a']) {
    const parsed = expressQuery(raw);
    assert.ok(Object.hasOwn(parsed, 'token') || Object.hasOwn(parsed, 'TOKEN'), `control: ${raw} -> ${JSON.stringify(parsed)}`);
  }
});

test('every query the canonicalizer forwards leaves req.query.token undefined under the real Express parser', () => {
  const spellings = [
    '[token]=a', '%5Btoken%5D=a', '%5btoken%5d=a', '[token][x]=a', '[token][]=a', '[token][x][y]=a', '%5Btoken%5D%5Bx%5D=a', 'TOKEN=a', 'Token=a',
    'token=a', 'token', 'token[]=a', 'token[x]=a', 'token.x=a', 'tok%65n=a', '%74%6F%6B%65%6E=a', '%5Btok%65n%5D=a', '+token=a', 'token%20=a', '[token]', '[TOKEN]=a',
    'a=1&token=b&c=2', 'token=1&token=2', '[token]=1&[token]=2', '%255Btoken%255D=a', 'a[token]=1', '[[token]]=a', '[token%5D=a', '%5Btoken]=a', 'token%5B%5D=a',
  ];
  for (const spelling of spellings) {
    const result = canonicalizeRequestTarget(`/api/projects?${spelling}`);
    if (!result.ok) continue; // refused outright is safe too
    assertNoTokenForExpress(result.canonical.query, spelling);
  }
  // Some of them must be accepted (not just all refused): the point is that the key is dropped, not the request.
  assert.ok(canonicalizeRequestTarget('/api/projects?[token]=a&keep=1').ok);
});

test('property: random queries built from bracket/percent/token pieces never leak a token key to the Express parser', () => {
  const random = createSeededRandom(0x5eed70c3);
  const pieces = ['token', 'Token', 'TOKEN', 'tok', 'en', '[', ']', '%5B', '%5b', '%5D', '%5d', '%74', '%6f', '%65', '%25', '%2e', '.', '=', '&', '+', '%20', 'a', 'x', '1', '[]', '=1', '%', '%zz', '%FF'];
  let accepted = 0;
  for (let i = 0; i < 30_000; i += 1) {
    let query = '';
    const count = random.int(1, 9);
    for (let j = 0; j < count; j += 1) query += random.pick(pieces);
    const result = canonicalizeRequestTarget(`/x?${query}`);
    if (!result.ok) continue;
    accepted += 1;
    assertNoTokenForExpress(result.canonical.query, JSON.stringify(query));
  }
  assert.ok(accepted > 3_000, `only ${accepted} queries survived: the property is not exercising the forwarding path`);
});

test('property: random targets never throw, and every accepted one is a plain, safe, idempotent path', () => {
  const random = createSeededRandom(0x07b21d9e);
  const pieces = ['/', '/', '/', '.', '..', 'api', 'auth', 'Projects', '%2e', '%2E', '%2f', '%5c', '%00', '%25', '%61', '%3b', ';', '\\', '?', '&', '=', 'token', '[', ']', '%5B', '%5D', '%', 'é', ' ', '#', '%C3%A1', '%ZZ', '\u0000', '\r', 'x'];
  for (let i = 0; i < 20_000; i += 1) {
    const count = random.int(0, 14);
    let input = random.next() < 0.9 ? '/' : '';
    for (let j = 0; j < count; j += 1) input += random.pick(pieces);
    const result = canonicalizeRequestTarget(input);
    if (!result.ok) continue;
    const { path, segments, query } = result.canonical;
    assert.match(path, /^\/[A-Za-z0-9\-._~!$&'()*+,:=@%/]*$/, `unsafe path for ${JSON.stringify(input)}`);
    assert.ok(!path.includes('//'), `empty segment for ${JSON.stringify(input)}`);
    assert.ok(!segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes(';')));
    assert.ok(!/[\u0000-\u001f\u007f]/.test(path + query));
    assertNoTokenForExpress(query, JSON.stringify(input));
    const again = canonicalizeRequestTarget(path + query);
    assert.ok(again.ok && again.canonical.path === path && again.canonical.query === query, `not idempotent: ${JSON.stringify(input)}`);
  }
});
