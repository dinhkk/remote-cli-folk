/**
 * What may reach the audit table (FR-42): commands are masked and cut to 200 characters, secret patterns
 * are replaced, details keep only short primitive values. Masking runs before the cut.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AUDIT_VALUE_MAX, maskSecrets, sanitizeAuditDetail, sanitizeAuditText } from '../../audit/audit-sanitizer.js';
import { classifyToolApproval, summarizeToolInput } from '../../audit/tool-input-summary.js';

const SECRETS: Array<[string, string]> = [
  ['curl -H "Authorization: Bearer abcdef123456" https://x.test', 'abcdef123456'],
  ['curl -H "authorization: Basic dXNlcjpwYXNz" https://x.test', 'dXNlcjpwYXNz'],
  ['gh api /user --header "Authorization:token ghp_0123456789abcdefghijABCDEFGHIJ0123"', 'ghp_0123456789abcdefghijABCDEFGHIJ0123'],
  ['npm publish --token npm_SECRETVALUE123', 'npm_SECRETVALUE123'],
  ['tool --token=hunter2hunter2', 'hunter2hunter2'],
  ['mysql -u root --password hunter2pass', 'hunter2pass'],
  ['export password=correct-horse-battery', 'correct-horse-battery'],
  ['login --user bob --passwd="my secret phrase"', 'my secret phrase'],
  ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop claude', 'sk-ant-api03-abcdefghijklmnop'],
  ['echo sk-proj-1234567890abcdef', 'sk-proj-1234567890abcdef'],
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY aws s3 ls', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'],
  ['DATABASE_PASSWORD=p4ssw0rd! ./run.sh', 'p4ssw0rd!'],
  ['MY_TOKEN=abc123 other', 'abc123'],
  ['git clone https://user:s3cr3tpass@github.com/x/y.git', 's3cr3tpass'],
  ['export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
  ['curl -H "X: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH" u', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH'],
  ['cat <<EOF\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----\nEOF', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu'],
];

test('secret patterns are masked: Authorization, Bearer, --token, password=, sk- keys, env-style KEY=..., tokens in URLs', () => {
  for (const [command, secret] of SECRETS) {
    const masked = maskSecrets(command);
    assert.ok(!masked.includes(secret), `${secret} leaked in: ${masked}`);
    assert.ok(masked.includes('***'), `nothing was masked in: ${command}`);
  }
});

test('ordinary commands are left alone', () => {
  for (const command of ['ls -la /tmp', 'git status', 'npm test -- --grep "token bucket"', 'echo hello world', 'cat README.md']) {
    assert.equal(maskSecrets(command), command);
  }
});

test('a command longer than 200 characters is cut to exactly 200 and marked', () => {
  const stored = sanitizeAuditText(`echo ${'a'.repeat(5000)}`);
  assert.equal(stored.length, AUDIT_VALUE_MAX);
  assert.ok(stored.endsWith('…'));
  assert.equal(sanitizeAuditText('short'), 'short');
});

/**
 * Every credential form the audit must mask, written with the placeholder `S` for the secret. The secret
 * `Zq7@Xv9 Lm2…` pieces are checked one by one: none may survive, whatever the form.
 */
const PIECES = ['Zq7', 'Xv9', 'Lm2', 'Kp4', 'Rt6'];
const NBSP = ' ';
const EM_SPACE = ' ';
const FORMS: Record<string, string> = {
  'json password': `curl -d '{"password":"Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json token with space after colon': `curl -d '{"token": "Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json api_key': `curl -d '{"user":"bob","api_key":"Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json apikey': `curl -d '{"apikey":"Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json secret': `curl -d '{"secret":"Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json authorization': `curl -d '{"authorization":"Bearer Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json cookie': `curl -d '{"cookie":"sid=Zq7Xv9Lm2Kp4Rt6; theme=dark"}' https://x.test`,
  'json set-cookie': `curl -d '{"set-cookie":"sid=Zq7Xv9Lm2Kp4Rt6; Path=/"}' https://x.test`,
  'json x-api-key': `curl -d '{"x-api-key":"Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json x-auth-token': `curl -d '{"x-auth-token":"Zq7Xv9Lm2Kp4Rt6"}' https://x.test`,
  'json inside a double-quoted shell string': `curl -d "{\\"password\\":\\"Zq7Xv9Lm2Kp4Rt6\\"}" https://x.test`,
  'yaml password': 'echo "password: Zq7Xv9Lm2Kp4Rt6" > c.yml',
  'yaml token': 'printf "token: Zq7Xv9Lm2Kp4Rt6\\n" >> c.yml',
  'yaml secret': 'secret: Zq7Xv9Lm2Kp4Rt6',
  'yaml api_key': 'api_key: Zq7Xv9Lm2Kp4Rt6',
  'yaml apikey': 'apikey: Zq7Xv9Lm2Kp4Rt6',
  'header X-Api-Key': 'curl -H "X-Api-Key: Zq7Xv9Lm2Kp4Rt6" https://x.test',
  'header X-Auth-Token': "curl -H 'X-Auth-Token: Zq7Xv9Lm2Kp4Rt6' https://x.test",
  'header Cookie with several pairs': 'curl -H "Cookie: sid=Zq7Xv9Lm2Kp4Rt6; csrf=Lm2Kp4Rt6Zq7Xv9; theme=dark" https://x.test',
  'header Set-Cookie': 'curl -H "Set-Cookie: sid=Zq7Xv9Lm2Kp4Rt6; HttpOnly" https://x.test',
  'header Authorization Basic': 'curl -H "Authorization: Basic Zq7Xv9Lm2Kp4Rt6" https://x.test',
  'curl -u user:pass': 'curl -u admin:Zq7Xv9Lm2Kp4Rt6 https://x.test',
  'curl -u quoted': 'curl -u "admin:Zq7Xv9Lm2Kp4Rt6" https://x.test',
  'curl --user': 'curl --user admin:Zq7Xv9Lm2Kp4Rt6 https://x.test',
  'mysql -pSecret': 'mysql -u root -pZq7Xv9Lm2Kp4Rt6 shop',
  'mysql -p Secret': 'mysql -u root -p Zq7Xv9Lm2Kp4Rt6 shop',
  'mysqldump -pSecret': 'mysqldump -h db -u root -pZq7Xv9Lm2Kp4Rt6 shop > dump.sql',
  'sshpass -p': 'sshpass -p Zq7Xv9Lm2Kp4Rt6 ssh host uptime',
  'docker login -p': 'docker login -u me -p Zq7Xv9Lm2Kp4Rt6 registry.test',
  'url userinfo': 'git clone https://bob:Zq7Xv9Lm2Kp4Rt6@host.test/x/y.git',
  'url userinfo with @ in the password': 'psql postgres://app:Zq7@Xv9@Lm2Kp4Rt6@db.test:5432/shop',
  'url userinfo with several @': 'git clone https://bob:Zq7@Xv9@Lm2@Kp4@Rt6@host.test/x.git',
  'escaped quote in a double-quoted value': 'tool --password "Zq7\\"Xv9 Lm2Kp4 Rt6" --verbose',
  'escaped quote in a single-quoted value': "tool --token 'Zq7\\'Xv9 Lm2Kp4 Rt6' --verbose",
  'unquoted value with a no-break space': `tool --password=Zq7${NBSP}Xv9${EM_SPACE}Lm2Kp4Rt6 --verbose`,
  'colon value with unicode spaces': `password: Zq7${NBSP}Xv9${EM_SPACE}Lm2Kp4Rt6`,
  'quoted value with unicode spaces': `tool --secret "Zq7${NBSP}Xv9${EM_SPACE}Lm2 Kp4 Rt6" --verbose`,
  'sk-': 'echo sk-Zq7Xv9Lm2Kp4Rt6',
  'sk_live_': 'curl -u sk_live_Zq7Xv9Lm2Kp4Rt6: https://api.stripe.test',
  'sk_test_': 'STRIPE=sk_test_Zq7Xv9Lm2Kp4Rt6 run',
  'AIza': 'curl "https://maps.test/api?key=AIzaZq7Xv9Lm2Kp4Rt6Zq7Xv9Lm2Kp4Rt6Qw3Er5"',
  'glpat-': 'git clone https://oauth2:glpat-Zq7Xv9Lm2Kp4Rt6Zq7X@gitlab.test/x.git',
  'glpat- bare': 'export T=glpat-Zq7Xv9Lm2Kp4Rt6Zq7X',
  'ghp_': 'echo ghp_Zq7Xv9Lm2Kp4Rt6Zq7Xv9Lm2',
  'gho_': 'echo gho_Zq7Xv9Lm2Kp4Rt6Zq7Xv9Lm2',
  'ghs_': 'echo ghs_Zq7Xv9Lm2Kp4Rt6Zq7Xv9Lm2',
  'github_pat_': 'echo github_pat_Zq7Xv9Lm2Kp4Rt6Zq7Xv9Lm2',
  'xoxb-': 'echo xoxb-Zq7Xv9Lm2Kp4Rt6-Zq7Xv9',
  'xoxa-': 'echo xoxa-Zq7Xv9Lm2Kp4Rt6-Zq7Xv9',
  'xoxp-': 'echo xoxp-Zq7Xv9Lm2Kp4Rt6-Zq7Xv9',
  'AKIA': 'echo AKIAZq7Xv9Lm2Kp4Rt6A',
  'JWT triple': 'echo eyJZq7Xv9Lm2Kp4.eyJXv9Lm2Kp4Rt6Zq7.Lm2Kp4Rt6Zq7Xv9',
};

test('every credential form is masked (JSON/YAML/colon, headers, -u, -p, URL userinfo, escaped quotes, unicode spaces, key prefixes)', () => {
  for (const [name, command] of Object.entries(FORMS)) {
    const masked = maskSecrets(command);
    assert.ok(masked.includes('***'), `${name}: nothing was masked in ${command}`);
    for (const piece of PIECES) assert.ok(!masked.includes(piece), `${name}: "${piece}" leaked in: ${masked}`);
    assert.equal(maskSecrets(masked), masked, `${name}: masking twice changes nothing`);
  }
});

test('the masks do not eat ordinary commands that merely look similar', () => {
  for (const command of [
    'mkdir -p /tmp/a/b',
    'ssh -p 22 host',
    'docker run -p 8080:80 nginx',
    'docker run -u 1000:1000 img',
    'find . -name x -print',
    'git commit -m "refresh the token cache"',
    'echo "cookie jar"',
    'curl https://example.com/@user/page?x=1',
    'git clone git@github.com:org/repo.git',
    'ls -u',
  ]) {
    assert.equal(maskSecrets(command), command);
  }
});

test('the rest of a Cookie header is masked, so a second cookie cannot leak', () => {
  const masked = maskSecrets('curl -H "Cookie: a=Zq7Xv9; b=Lm2Kp4Rt6" https://x.test');
  assert.equal(masked, 'curl -H "Cookie: ***" https://x.test');
});

test('URL userinfo is masked up to the LAST @ before the host, and the host stays visible', () => {
  assert.equal(maskSecrets('psql postgres://u:p@ss@word@db.test:5432/shop'), 'psql postgres://***@db.test:5432/shop');
});

test('a secret that straddles the 200th character is masked before the cut, not half shown (every start index 150..199, every form)', () => {
  for (const [name, form] of Object.entries(FORMS)) {
    for (let start = 150; start <= 199; start += 1) {
      const command = `${'x'.repeat(start)} ${form}`;
      const stored = sanitizeAuditText(command);
      assert.ok(stored.length <= AUDIT_VALUE_MAX, `${name}@${start}: too long`);
      for (const piece of PIECES) assert.ok(!stored.includes(piece), `${name}@${start}: "${piece}" leaked: ${stored}`);
      // A mask marker that the cut would split is dropped whole (no dangling "*" or "**" before the cut mark).
      assert.ok(!/(?<!\*)\*{1,2}…$/.test(stored), `${name}@${start}: a split mask marker is left: ${stored}`);
    }
  }
});

test('masking is applied to the whole string before the cut: a value that starts before and ends after the 200th character', () => {
  const stored = sanitizeAuditText(`${'x'.repeat(190)} --password "Zq7 Xv9 Lm2 Kp4 Rt6 and more words after the cut"`);
  assert.ok(stored.length <= AUDIT_VALUE_MAX);
  for (const piece of PIECES) assert.ok(!stored.includes(piece), stored);
  assert.ok(!stored.includes('Zq'), stored);
});

test('bidi controls and zero-width characters are replaced in labels, commands and routes', () => {
  const hostile = '‮evil‬ ⁦x⁩ a​b‏c‎d‪e‫f‭g﻿h؜i';
  for (const text of [hostile, `rm -rf ${hostile}`, `GET /api/${hostile}`]) {
    const stored = sanitizeAuditText(text);
    assert.ok(!/[‪-‮⁦-⁩​-‏﻿؜]/.test(stored), `bidi/zero-width left in: ${JSON.stringify(stored)}`);
  }
  assert.equal(sanitizeAuditText('‮abc'), '?abc');
  const detail = sanitizeAuditDetail({ command: `ls ‮fdp.exe`, updatedCommand: 'x​y' });
  assert.ok(!/[‪-‮​]/.test(JSON.stringify(Object.values(detail))));
});

test('control characters become "?" and a huge input is bounded', () => {
  assert.equal(sanitizeAuditText('a\u0000b\nc\u001bd'), 'a?b?c?d');
  const started = Date.now();
  sanitizeAuditText(`${'password='.repeat(200_000)}x`);
  assert.ok(Date.now() - started < 2000, 'masking a hostile megabyte must stay fast');
});

test('detail keeps short primitives only: no objects, arrays, odd keys, and file contents never come through as a value', () => {
  const detail = sanitizeAuditDetail({
    tool: 'Bash',
    command: `echo ${'z'.repeat(1000)}`,
    ok: true,
    count: 3,
    nested: { content: 'FILE CONTENTS' },
    list: ['a'],
    'bad key!': 'x',
    __proto__: 'x',
    nan: Number.NaN,
    fn: () => 1,
  } as Record<string, unknown>);
  assert.deepEqual(Object.keys(detail).sort(), ['command', 'count', 'ok', 'tool']);
  assert.equal((detail.command as string).length, AUDIT_VALUE_MAX);
  assert.deepEqual(sanitizeAuditDetail(undefined), {});
  const many = sanitizeAuditDetail(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, 'v'])));
  assert.equal(Object.keys(many).length, 12);
});

test('tool approval cards: S1 tool, S2 question, S3 plan; only the command/path/url of a few tools is kept', () => {
  assert.equal(classifyToolApproval('Bash'), 'S1');
  assert.equal(classifyToolApproval('AskUserQuestion'), 'S2');
  assert.equal(classifyToolApproval('question'), 'S2');
  assert.equal(classifyToolApproval('ExitPlanMode'), 'S3');
  assert.deepEqual(summarizeToolInput('Bash', { command: 'ls', description: 'list' }), { command: 'ls' });
  assert.deepEqual(summarizeToolInput('Write', { file_path: '/a/b.txt', content: 'SECRET CONTENT' }), { path: '/a/b.txt' });
  assert.deepEqual(summarizeToolInput('Edit', { file_path: '/a/b.txt', old_string: 'x', new_string: 'y' }), { path: '/a/b.txt' });
  assert.deepEqual(summarizeToolInput('ExitPlanMode', { plan: 'a long plan' }), {});
  assert.deepEqual(summarizeToolInput('AskUserQuestion', { questions: [{ question: 'q?' }] }), {});
  assert.deepEqual(summarizeToolInput('Bash', 'not an object'), {});
});
