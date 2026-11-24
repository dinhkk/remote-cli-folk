import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_HTTP_METHODS,
  REMOTE_ALLOW_RULES,
  REMOTE_DENY_RULES,
  classifyRoute,
  createRemoteHttpPolicy,
  evaluateRemoteHttpRequest,
  evaluateRemoteWebSocketTarget,
} from '../../policy/route-allow-list.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const NOT_ALLOWED_METHODS = ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'get', 'Get', 'patch', '', 'GET ', 'GET\r\n'];

/** A concrete request path for a rule pattern: `*` becomes a segment, a trailing `/**` a few more. */
const sampleOf = (pattern: string, tail = 'sub/path'): string =>
  pattern.replace(/\/\*\*$/, `/${tail}`).replace(/\*/g, 'x') || '/';

/** Independent segment matcher for the table's pattern syntax (the test must not reuse the code under test). */
const patternMatches = (pattern: string, path: string): boolean => {
  const want = pattern.split('/').filter(Boolean);
  const have = path.toLowerCase().split('/').filter(Boolean);
  const rest = want[want.length - 1] === '**';
  const head = rest ? want.slice(0, -1) : want;
  if (rest ? have.length < head.length : have.length !== head.length) return false;
  return head.every((part, index) => part === '*' || part === have[index]);
};

test('the method list is exactly GET POST PUT PATCH DELETE', () => {
  assert.deepEqual([...ALLOWED_HTTP_METHODS], [...METHODS]);
});

test('every allow rule lists exactly one method and a note, every deny rule a note (the table documents itself)', () => {
  for (const rule of REMOTE_ALLOW_RULES) {
    assert.equal(rule.methods.length, 1, rule.pattern);
    assert.ok((METHODS as readonly string[]).includes(rule.methods[0]), rule.pattern);
    assert.ok(rule.note.length > 0, rule.pattern);
  }
  for (const rule of REMOTE_DENY_RULES) assert.ok(rule.note.length > 0, rule.pattern);
});

test('the allow list is exact: no wildcard tail, no duplicate (method, pattern), nothing a deny rule already covers', () => {
  const seen = new Set<string>();
  for (const rule of REMOTE_ALLOW_RULES) {
    assert.ok(!rule.pattern.includes('**'), `${rule.pattern} is a prefix rule`);
    const key = `${rule.methods[0]} ${rule.pattern}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    const shadow = REMOTE_DENY_RULES.find((deny) => patternMatches(deny.pattern, sampleOf(rule.pattern)) && (deny.methods === undefined || deny.methods.includes(rule.methods[0])));
    assert.equal(shadow, undefined, `${key} is shadowed by deny rule ${shadow?.pattern}`);
  }
});

// ---------------------------------------------------------------------------
// Allow rules x methods
// ---------------------------------------------------------------------------

for (const rule of REMOTE_ALLOW_RULES) {
  test(`${rule.methods[0]} ${rule.pattern} is allowed, every other method on that path is refused unless another rule lists it`, () => {
    const plain = sampleOf(rule.pattern);
    for (const path of [plain, plain.toUpperCase()]) {
      assert.equal(evaluateRemoteHttpRequest(rule.methods[0], path).allowed, true, `${rule.methods[0]} ${path}`);
      for (const method of METHODS) {
        if (method === rule.methods[0]) continue;
        const listed = REMOTE_ALLOW_RULES.some((other) => other.methods[0] === method && patternMatches(other.pattern, path));
        const decision = evaluateRemoteHttpRequest(method, path);
        assert.equal(decision.allowed, listed, `${method} ${path}: ${JSON.stringify(decision)}`);
        if (!decision.allowed) assert.ok(decision.reason === 'method-not-allowed' || decision.reason === 'route-denied');
      }
    }
  });
}

test('an allowed route does not extend to sub-paths or look-alikes (exact list, not a prefix)', () => {
  for (const path of [
    '/api/projects/a/b/c/d',
    '/api/projects/clone-progress/extra',
    '/api/git/status/extra',
    '/api/git/statusx',
    '/api/file-tree/projects/p1/files/content/extra',
    '/api/file-tree/anything',
    '/api/assets/files/a/b',
    '/api/assets/images/a/b',
    '/api/providers/claude/models/x/y',
    '/api/worktrees/x',
    '/api/commands',
    '/api/commands/other',
  ]) {
    assert.equal(evaluateRemoteHttpRequest('GET', path).allowed, false, path);
    assert.equal(evaluateRemoteHttpRequest('POST', path).allowed, false, path);
  }
});

test('other methods are refused everywhere, even on an allowed route', () => {
  for (const method of NOT_ALLOWED_METHODS) {
    for (const path of ['/api/projects', '/api/git/status', '/api/user/drafts']) {
      const decision = evaluateRemoteHttpRequest(method, path);
      assert.deepEqual(decision, { allowed: false, reason: 'method-not-allowed' }, `${JSON.stringify(method)} ${path}`);
    }
  }
});

test('a method that a rule does not list is refused as method-not-allowed', () => {
  assert.deepEqual(evaluateRemoteHttpRequest('POST', '/api/user/onboarding-status'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/user/complete-onboarding'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(evaluateRemoteHttpRequest('PATCH', '/api/user/drafts/queued-message'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(evaluateRemoteHttpRequest('POST', '/api/projects'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/projects/p1'), { allowed: false, reason: 'method-not-allowed' });
});

// ---------------------------------------------------------------------------
// Deny rules always win
// ---------------------------------------------------------------------------

for (const rule of REMOTE_DENY_RULES) {
  const methods = rule.methods ?? METHODS;
  test(`denies ${methods.join('|')} ${rule.pattern} (${rule.note})`, () => {
    for (const method of methods) {
      for (const path of [sampleOf(rule.pattern), sampleOf(rule.pattern, 'a/b/c')]) {
        const decision = evaluateRemoteHttpRequest(method, path);
        assert.deepEqual(decision, { allowed: false, reason: 'route-denied' }, `${method} ${path}`);
      }
    }
  });
}

test('the documented always-blocked groups are all present', () => {
  const patterns = REMOTE_DENY_RULES.map((rule) => rule.pattern);
  for (const expected of [
    '/api/auth/**',
    '/api/settings/**',
    '/api/notifications/**',
    '/api/plugins/**',
    '/plugin-ws/**',
    '/desktop-notifications',
    '/api/system/**',
    '/api/agent/**',
    '/api/browser-use/**',
    '/api/browser-use-mcp/**',
    '/api/user/git-config',
    '/api/user/preferences',
    '/api/taskmaster/**',
    '/api/voice/**',
    '/api/remote/**',
    '/api/providers/*/cli/**',
    '/api/providers/*/auth/**',
    '/api/providers/*/mcp/**',
    '/api/providers/mcp/**',
    '/api/providers/*/settings-permissions',
  ]) {
    assert.ok(patterns.includes(expected), `missing deny rule ${expected}`);
  }
});

test('provider CLI install/update, provider auth, MCP configuration and settings permissions are refused for every method and spelling', () => {
  for (const method of METHODS) {
    for (const path of [
      '/api/providers/claude/cli',
      '/api/providers/claude/cli/',
      '/api/providers/claude/cli/update',
      '/api/providers/codex/cli/anything/else',
      '/api/providers/claude/auth',
      '/api/providers/claude/auth/status',
      '/api/providers/claude/auth/login/start',
      '/API/Providers/Claude/CLI/Update',
      '/api/providers/Claude/AUTH/Status',
      '/api/providers/%63laude/%63li/update',
      '/api/providers/claude/./cli/update',
      '/api/providers/claude/x/../auth/status',
      '/api/providers/claude/mcp/servers',
      '/api/providers/claude/mcp/servers/some-server',
      '/api/providers/mcp/servers/global',
      '/API/Providers/MCP/Servers/Global',
      '/api/providers/claude/settings-permissions',
    ]) {
      const decision = evaluateRemoteHttpRequest(method, path);
      assert.equal(decision.allowed, false, `${method} ${path}`);
    }
  }
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/providers/claude/models').allowed, true);
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/providers/claude/skills').allowed, true);
});

test('the Host preferences are neither read nor written from Remote (the tab keeps its own)', () => {
  for (const method of METHODS) {
    assert.deepEqual(evaluateRemoteHttpRequest(method, '/api/user/preferences'), { allowed: false, reason: 'route-denied' }, method);
    assert.deepEqual(evaluateRemoteHttpRequest(method, '/API/User/Preferences/'), { allowed: false, reason: 'route-denied' }, method);
  }
});

test('/api/user/git-config is denied for every method', () => {
  for (const method of METHODS) assert.deepEqual(evaluateRemoteHttpRequest(method, '/api/user/git-config'), { allowed: false, reason: 'route-denied' });
});

test('unlisted /api/user routes are not reachable', () => {
  for (const path of ['/api/user', '/api/user/', '/api/user/anything', '/api/user/preferences/extra', '/api/user/drafts-extra']) {
    assert.equal(evaluateRemoteHttpRequest('GET', path).allowed, false, path);
  }
});

test('a project TaskMaster read is refused although the project routes around it are allowed', () => {
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/projects/p1/taskmaster'), { allowed: false, reason: 'route-denied' });
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/projects/p1/sessions').allowed, true);
});

// ---------------------------------------------------------------------------
// Default deny
// ---------------------------------------------------------------------------

test('unknown routes are refused by default (route-unknown), including static files and the SPA', () => {
  for (const path of [
    '/',
    '/api',
    '/api/',
    '/api/unknown',
    '/api/projectsX',
    '/api/projects-evil',
    '/api/git2/status',
    '/apix/projects',
    '/assets/index.js',
    '/index.html',
    '/favicon.ico',
    '/health',
    '/ws',
    '/shell',
    '/r/peer/api/projects',
    '/api-docs.html',
  ]) {
    const decision = evaluateRemoteHttpRequest('GET', path);
    assert.equal(decision.allowed, false, path);
  }
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/unknown'), { allowed: false, reason: 'route-unknown' });
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/'), { allowed: false, reason: 'route-unknown' });
});

test('/health is classified explicitly (the Controller answers it itself)', () => {
  assert.equal(classifyRoute('GET', ['health']).verdict, 'deny');
});

// ---------------------------------------------------------------------------
// Matching is case-insensitive, forwarding keeps the case
// ---------------------------------------------------------------------------

test('matching ignores case but the forwarded path keeps the Controller case (Report.PDF reaches the Host as Report.PDF)', () => {
  const decision = evaluateRemoteHttpRequest('GET', '/API/Assets/Files/Report.PDF?x=1');
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.canonical.path, '/API/Assets/Files/Report.PDF');
  assert.equal(decision.canonical.query, '?x=1');
  assert.deepEqual(decision.canonical.segments, ['API', 'Assets', 'Files', 'Report.PDF']);

  assert.deepEqual(evaluateRemoteHttpRequest('POST', '/API/AUTH/Login'), { allowed: false, reason: 'route-denied' });
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/Api/Settings/Api-Keys'), { allowed: false, reason: 'route-denied' });
});

test('matching is ASCII-only: a Kelvin sign (U+212A) is not a k, exactly like the Host router', () => {
  // The Host's route regexes are case-insensitive without the `u` flag, and that comparison never folds a
  // non-ASCII letter onto an ASCII one, so `wor<Kelvin>trees` is not `worktrees` there. String#toLowerCase()
  // WOULD fold U+212A to "k": a matcher built on it would allow a path the Host then answers differently.
  const kelvin = '%E2%84%AA';
  assert.equal('K'.toLowerCase(), 'k', 'precondition: this is the character toLowerCase() folds');

  // Real allow route with a k: with toLowerCase() this would be allowed.
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/worktrees').allowed, true);
  assert.deepEqual(evaluateRemoteHttpRequest('GET', `/api/wor${kelvin}trees`), { allowed: false, reason: 'route-unknown' });
  // Real deny family with a k: with toLowerCase() this would be route-denied instead of unknown.
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/taskmaster/installation-status'), { allowed: false, reason: 'route-denied' });
  assert.deepEqual(evaluateRemoteHttpRequest('GET', `/api/tas${kelvin}master/installation-status`), { allowed: false, reason: 'route-unknown' });
  // The plain ASCII upper-case form is still matched case-insensitively.
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/WORKTREES').allowed, true);
});

// ---------------------------------------------------------------------------
// Canonicalization is in front of the matcher
// ---------------------------------------------------------------------------

test('evasions of a denied route are denied (decoded once, dot segments and // collapsed)', () => {
  for (const path of [
    '/api/%61uth/login',
    '/api/%41UTH/login',
    '/api//auth/login',
    '/api/./auth/login',
    '/api/projects/../auth/login',
    '/api/x/../auth/login',
    '/api/auth/',
    '/api/auth//login',
    '/api/settings/%61pi-keys',
    '/api/Settings//api-keys',
    '/api/projects/../settings/credentials',
    '/api/projects/../../api/agent',
  ]) {
    const decision = evaluateRemoteHttpRequest('POST', path);
    assert.deepEqual(decision, { allowed: false, reason: 'route-denied' }, path);
  }
});

test('hostile targets are refused as invalid-target with the canonicalizer reason', () => {
  const cases: Array<[string, string]> = [
    ['/api/%2e%2e/auth', 'encoded-dot-segment'],
    ['/api/%252e%252e/auth', 'double-encoding'],
    ['/api/auth;x=1', 'path-parameter'],
    ['/api/%2fauth', 'encoded-separator'],
    ['/api/%5cauth', 'encoded-separator'],
    ['/api/%00', 'control-character'],
    ['http://x/api/projects', 'not-origin-form'],
    ['https://evil.com/api/projects', 'not-origin-form'],
    ['//evil.com/api/projects', 'protocol-relative'],
    ['/api/projects.', 'trailing-dot'],
    ['/../api/projects', 'traversal-above-root'],
    [`/api/${'a'.repeat(5000)}`, 'too-long'],
  ];
  for (const [target, detail] of cases) {
    assert.deepEqual(evaluateRemoteHttpRequest('GET', target), { allowed: false, reason: 'invalid-target', detail }, target);
  }
});

test('the token query key never survives into the decision', () => {
  const decision = evaluateRemoteHttpRequest('GET', '/api/projects?token=SECRET&a=1');
  assert.ok(decision.allowed);
  assert.equal(decision.canonical.query, '?a=1');
});

// ---------------------------------------------------------------------------
// Classification of representative mounted routes (the exhaustive sweep is route-inventory.test.ts)
// ---------------------------------------------------------------------------

const MOUNTED: Array<[string, string, 'allow' | 'deny']> = [
  ['GET', '/api/projects', 'allow'],
  ['GET', '/api/projects/archived', 'allow'],
  ['GET', '/api/projects/p1/sessions', 'allow'],
  ['POST', '/api/projects/create-project', 'allow'],
  ['POST', '/api/projects/clone', 'allow'],
  ['GET', '/api/projects/clone-progress', 'allow'],
  ['PUT', '/api/projects/p1/rename', 'allow'],
  ['POST', '/api/projects/p1/toggle-star', 'allow'],
  ['DELETE', '/api/projects/p1', 'allow'],
  ['GET', '/api/file-tree/browse-filesystem', 'allow'],
  ['POST', '/api/file-tree/create-folder', 'allow'],
  ['GET', '/api/file-tree/projects/p1/file', 'allow'],
  ['GET', '/api/file-tree/projects/p1/files/content', 'allow'],
  // The Local HTML preview page runs the file's script; a Remote tab never loads it.
  ['GET', '/api/file-tree/projects/p1/files/html-preview', 'deny'],
  ['PUT', '/api/file-tree/projects/p1/file', 'allow'],
  ['POST', '/api/file-tree/projects/p1/files/upload', 'allow'],
  ['DELETE', '/api/file-tree/projects/p1/files', 'allow'],
  ['GET', '/api/git/status', 'allow'],
  ['POST', '/api/git/commit', 'allow'],
  ['POST', '/api/git/push', 'allow'],
  ['GET', '/api/worktrees', 'allow'],
  ['POST', '/api/worktrees/create', 'allow'],
  ['POST', '/api/commands/list', 'allow'],
  ['POST', '/api/commands/execute', 'allow'],
  ['GET', '/api/providers/claude/models', 'allow'],
  ['GET', '/api/providers/sessions/running', 'allow'],
  ['GET', '/api/providers/search/sessions', 'allow'],
  ['GET', '/api/providers/claude/capabilities', 'allow'],
  ['GET', '/api/scheduled-messages', 'allow'],
  ['POST', '/api/scheduled-messages', 'allow'],
  ['DELETE', '/api/scheduled-messages/s1', 'allow'],
  ['POST', '/api/assets/images', 'allow'],
  ['GET', '/api/assets/images/a.png', 'allow'],
  ['POST', '/api/assets/files', 'allow'],
  ['GET', '/api/assets/files/Report.PDF', 'allow'],
  ['GET', '/api/user/drafts', 'allow'],
  ['PUT', '/api/user/drafts', 'allow'],
  ['DELETE', '/api/user/drafts', 'allow'],
  ['POST', '/api/user/drafts/queued-message', 'allow'],
  ['DELETE', '/api/user/drafts/queued-message', 'allow'],
  ['GET', '/api/user/onboarding-status', 'allow'],
  ['POST', '/api/user/complete-onboarding', 'allow'],
  ['GET', '/api/auth/status', 'deny'],
  ['POST', '/api/auth/login', 'deny'],
  ['POST', '/api/auth/register', 'deny'],
  ['POST', '/api/auth/refresh', 'deny'],
  ['POST', '/api/auth/logout-all', 'deny'],
  ['GET', '/api/auth/user', 'deny'],
  ['GET', '/api/settings/api-keys', 'deny'],
  ['POST', '/api/settings/credentials', 'deny'],
  ['POST', '/api/settings/push/subscribe', 'deny'],
  ['GET', '/api/notifications/endpoints', 'deny'],
  ['PATCH', '/api/notifications/endpoints/web/e1', 'deny'],
  ['GET', '/api/plugins', 'deny'],
  ['PUT', '/api/plugins/p/enable', 'deny'],
  ['POST', '/api/plugins/install', 'deny'],
  ['POST', '/api/system/update', 'deny'],
  ['POST', '/api/agent', 'deny'],
  ['GET', '/api/browser-use/status', 'deny'],
  ['POST', '/api/browser-use-mcp/tools/t', 'deny'],
  ['GET', '/api/taskmaster/installation-status', 'deny'],
  ['GET', '/api/projects/p1/taskmaster', 'deny'],
  ['GET', '/api/voice/health', 'deny'],
  ['POST', '/api/voice/tts', 'deny'],
  ['GET', '/api/user/git-config', 'deny'],
  ['POST', '/api/user/git-config', 'deny'],
  ['GET', '/api/user/preferences', 'deny'],
  ['PATCH', '/api/user/preferences', 'deny'],
  ['GET', '/api/providers/claude/auth/status', 'deny'],
  ['GET', '/api/providers/claude/cli', 'deny'],
  ['POST', '/api/providers/claude/cli/update', 'deny'],
  ['GET', '/api/providers/claude/mcp/servers', 'deny'],
  ['POST', '/api/providers/claude/mcp/servers', 'deny'],
  ['DELETE', '/api/providers/claude/mcp/servers/s1', 'deny'],
  ['POST', '/api/providers/mcp/servers/global', 'deny'],
  ['GET', '/api/providers/claude/settings-permissions', 'deny'],
  ['GET', '/api/remote/peers', 'deny'],
  ['GET', '/health', 'deny'],
];

for (const [method, path, expected] of MOUNTED) {
  test(`mounted route ${method} ${path} is classified ${expected} (never unknown)`, () => {
    const decision = evaluateRemoteHttpRequest(method, path);
    assert.equal(decision.allowed, expected === 'allow', JSON.stringify(decision));
    if (!decision.allowed) assert.notEqual(decision.reason, 'route-unknown');
  });
}

test('classifyRoute exposes the matching rule for reports and the exhaustive sweep', () => {
  assert.deepEqual(classifyRoute('GET', ['api', 'projects', 'x', 'sessions']), { verdict: 'allow', rule: '/api/projects/*/sessions' });
  assert.deepEqual(classifyRoute('GET', ['api', 'projects']), { verdict: 'allow', rule: '/api/projects' });
  assert.equal(classifyRoute('GET', ['api', 'auth']).verdict, 'deny');
  assert.deepEqual(classifyRoute('GET', ['api', 'projects', 'x', 'y', 'z']), { verdict: 'unknown', rule: null });
  assert.deepEqual(classifyRoute('GET', ['api', 'nothing']), { verdict: 'unknown', rule: null });
  assert.equal(classifyRoute('GET', []).verdict, 'unknown');
});

test('createRemoteHttpPolicy adds allow rules on top of the production table; the deny rules still win', () => {
  const policy = createRemoteHttpPolicy({ extraAllow: [{ pattern: '/api/projects/**', methods: ['GET', 'POST'], note: 'test' }, { pattern: '/api/auth/**', methods: ['GET'], note: 'test' }] });
  assert.equal(policy('GET', '/api/projects/echo').allowed, true);
  assert.equal(policy('POST', '/api/projects/echo').allowed, true);
  assert.deepEqual(policy('PUT', '/api/projects/echo'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(policy('GET', '/api/auth/user'), { allowed: false, reason: 'route-denied' });
  assert.deepEqual(policy('GET', '/api/projects/p1/taskmaster'), { allowed: false, reason: 'route-denied' });
  // the production policy is untouched
  // (`/api/projects/*` is a DELETE rule, so a GET there is refused for its method)
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/projects/echo'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(evaluateRemoteHttpRequest('POST', '/api/projects/echo'), { allowed: false, reason: 'method-not-allowed' });
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/projects/echo/x/y'), { allowed: false, reason: 'route-unknown' });
});

// ---------------------------------------------------------------------------
// WebSocket targets
// ---------------------------------------------------------------------------

test('WebSocket opens are allowed only for /ws (chat) and /shell, with the query dropped', () => {
  assert.deepEqual(evaluateRemoteWebSocketTarget('/ws'), { allowed: true, channel: 'chat', path: '/ws' });
  assert.deepEqual(evaluateRemoteWebSocketTarget('/shell'), { allowed: true, channel: 'shell', path: '/shell' });
  assert.deepEqual(evaluateRemoteWebSocketTarget('/ws?token=TAB'), { allowed: true, channel: 'chat', path: '/ws' });
  assert.deepEqual(evaluateRemoteWebSocketTarget('/shell?x=1&token=TAB'), { allowed: true, channel: 'shell', path: '/shell' });
  assert.deepEqual(evaluateRemoteWebSocketTarget('/ws/'), { allowed: true, channel: 'chat', path: '/ws' });
  assert.deepEqual(evaluateRemoteWebSocketTarget('/./ws'), { allowed: true, channel: 'chat', path: '/ws' });
});

test('every other WebSocket path is refused', () => {
  for (const target of ['/WS', '/Shell', '/ws/extra', '/shell/x', '/plugin-ws/p', '/desktop-notifications', '/api/ws', '/', '/wss', '/%77s/x', '/x/../plugin-ws/p']) {
    const decision = evaluateRemoteWebSocketTarget(target);
    assert.equal(decision.allowed, false, target);
    if (!decision.allowed) assert.equal(decision.reason, 'websocket-path', target);
  }
  // an encoded "ws" is decoded once, so it is the real /ws
  assert.deepEqual(evaluateRemoteWebSocketTarget('/%77s'), { allowed: true, channel: 'chat', path: '/ws' });
});

test('hostile WebSocket targets are refused as invalid-target', () => {
  for (const [target, detail] of [
    ['//evil.com/ws', 'protocol-relative'],
    ['http://x/ws', 'not-origin-form'],
    ['/ws;x', 'path-parameter'],
    ['/%2e%2e/ws', 'encoded-dot-segment'],
    ['/ws%2f', 'encoded-separator'],
  ] as const) {
    assert.deepEqual(evaluateRemoteWebSocketTarget(target), { allowed: false, reason: 'invalid-target', detail }, target);
  }
});
