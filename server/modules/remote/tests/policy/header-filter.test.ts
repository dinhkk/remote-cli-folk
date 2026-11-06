import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUEST_HEADER_ALLOW_LIST,
  RESPONSE_HEADER_ALLOW_LIST,
  SANDBOX_CSP,
  filterRequestHeaders,
  filterResponseHeaders,
  isJsonOrEventStream,
} from '../../policy/header-filter.js';

// ---------------------------------------------------------------------------
// Controller -> Host
// ---------------------------------------------------------------------------

test('the request allow-list is exactly the contract list (contracts section 7)', () => {
  assert.deepEqual([...REQUEST_HEADER_ALLOW_LIST].sort(), ['accept', 'accept-language', 'content-length', 'content-type', 'if-modified-since', 'if-none-match', 'range', 'x-request-id']);
});

test('request: every allow-listed header is forwarded, lower-cased, and nothing else is added', () => {
  const verdict = filterRequestHeaders({
    'Content-Type': 'application/json',
    'Content-Length': '12',
    Accept: 'application/json, text/plain;q=0.9',
    'Accept-Language': 'vi,en;q=0.8',
    'If-None-Match': 'W/"abc"',
    'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT',
    Range: 'bytes=0-99',
    'X-Request-Id': 'req-1234',
  });
  assert.deepEqual(verdict, {
    ok: true,
    headers: {
      'content-type': 'application/json',
      'content-length': '12',
      accept: 'application/json, text/plain;q=0.9',
      'accept-language': 'vi,en;q=0.8',
      'if-none-match': 'W/"abc"',
      'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
      range: 'bytes=0-99',
      'x-request-id': 'req-1234',
    },
  });
});

const DROPPED_REQUEST_HEADERS = [
  'Authorization',
  'authorization',
  'AUTHORIZATION',
  'Cookie',
  'Origin',
  'Referer',
  'Host',
  'Forwarded',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Real-IP',
  'Via',
  'Proxy-Authorization',
  'Proxy-Connection',
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-Dest',
  'Sec-Fetch-User',
  'Sec-WebSocket-Key',
  'Sec-WebSocket-Protocol',
  'Sec-WebSocket-Extensions',
  'x-browser-use-mcp-token',
  'x-api-key',
  'X-API-KEY',
  'X-Setup-Token',
  'Connection',
  'Keep-Alive',
  'TE',
  'Trailer',
  'Transfer-Encoding',
  'Upgrade',
  'Expect',
  'User-Agent',
  'Accept-Encoding',
  'X-Refreshed-Token',
  'X-Auth-Error',
  'Content-Encoding',
  'Content-Disposition',
  'Cache-Control',
  'Pragma',
  'X-Custom',
  'X-HTTP-Method-Override',
  'X-Original-URL',
  'X-Rewrite-URL',
  ':authority',
  ':path',
  '__proto__',
  'constructor',
  'toString',
  '',
  ' ',
  'content-type ',
  ' content-type',
  'content_type',
];

test('request: every non-listed header is dropped (auth, cookies, origin, forwarding, hop-by-hop, WebSocket, tokens...)', () => {
  for (const name of DROPPED_REQUEST_HEADERS) {
    const verdict = filterRequestHeaders({ [name]: 'value', accept: 'x/y' });
    assert.deepEqual(verdict, { ok: true, headers: { accept: 'x/y' } }, JSON.stringify(name));
  }
});

test('request: dropping everything at once leaves an empty header set', () => {
  const headers = Object.fromEntries(DROPPED_REQUEST_HEADERS.map((name) => [name, 'v']));
  assert.deepEqual(filterRequestHeaders(headers), { ok: true, headers: {} });
});

test('request: the Controller cannot smuggle the Host credentials in, whatever the spelling', () => {
  const verdict = filterRequestHeaders({ Authorization: 'Bearer stolen', 'x-api-key': 'k', Cookie: 'a=b', 'proxy-authorization': 'x' });
  assert.deepEqual(verdict, { ok: true, headers: {} });
});

test('request: a header repeated in two spellings is refused (ambiguity is how requests get smuggled)', () => {
  assert.deepEqual(filterRequestHeaders({ 'Content-Length': '5', 'content-length': '5' }), { ok: false, reason: 'duplicate-header' });
  assert.deepEqual(filterRequestHeaders({ 'Content-Type': 'a/b', 'CONTENT-TYPE': 'c/d' }), { ok: false, reason: 'duplicate-header' });
  assert.deepEqual(filterRequestHeaders({ Accept: 'a/b', accept: 'a/b' }), { ok: false, reason: 'duplicate-header' });
});

test('request: array values must hold exactly one entry', () => {
  assert.deepEqual(filterRequestHeaders({ accept: ['text/plain'] }), { ok: true, headers: { accept: 'text/plain' } });
  assert.deepEqual(filterRequestHeaders({ accept: ['a/b', 'c/d'] }), { ok: false, reason: 'invalid-header-value' });
  assert.deepEqual(filterRequestHeaders({ 'content-length': ['5', '5'] }), { ok: false, reason: 'invalid-header-value' });
  assert.deepEqual(filterRequestHeaders({ accept: [] }), { ok: false, reason: 'invalid-header-value' });
  // arrays of dropped headers do not matter
  assert.deepEqual(filterRequestHeaders({ cookie: ['a=b', 'c=d'] }), { ok: true, headers: {} });
});

test('request: values with CR, LF, NUL, DEL, non-ASCII or absurd length are refused (header injection)', () => {
  for (const value of ['a\r\nX-Injected: 1', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'café', '你好', 'x'.repeat(8193)]) {
    assert.deepEqual(filterRequestHeaders({ accept: value }), { ok: false, reason: 'invalid-header-value' }, JSON.stringify(value.slice(0, 20)));
    assert.deepEqual(filterRequestHeaders({ 'x-request-id': value }), { ok: false, reason: 'invalid-header-value' });
  }
  assert.deepEqual(filterRequestHeaders({ accept: 'a\tb' }), { ok: true, headers: { accept: 'a\tb' } }, 'a tab is legal');
  // A hostile value in a header that is dropped anyway is simply dropped, never forwarded.
  assert.deepEqual(filterRequestHeaders({ cookie: 'a\r\nb' }), { ok: true, headers: {} });
});

test('request: Content-Length must be a plain decimal; anything else could desynchronise the loopback request', () => {
  for (const value of ['0', '5', '1234567', '26214400']) {
    assert.deepEqual(filterRequestHeaders({ 'content-length': value }), { ok: true, headers: { 'content-length': value } });
  }
  for (const value of ['', ' ', '-1', '+5', '1e3', '0x10', ' 5', '5 ', '5, 5', '5;6', '05', '00', '1.5', 'abc', '9'.repeat(16), '5\r\nTransfer-Encoding: chunked']) {
    const verdict = filterRequestHeaders({ 'content-length': value });
    assert.equal(verdict.ok, false, JSON.stringify(value));
    if (!verdict.ok) assert.ok(verdict.reason === 'invalid-content-length' || verdict.reason === 'invalid-header-value');
  }
});

test('request: Transfer-Encoding is never forwarded, so a Content-Length / chunked conflict cannot be created', () => {
  assert.deepEqual(filterRequestHeaders({ 'content-length': '5', 'transfer-encoding': 'chunked' }), { ok: true, headers: { 'content-length': '5' } });
  assert.deepEqual(filterRequestHeaders({ 'Transfer-Encoding': 'chunked, identity' }), { ok: true, headers: {} });
});

test('request: __proto__ keys from JSON cannot pollute anything and are dropped', () => {
  const hostile = JSON.parse('{"__proto__":{"authorization":"x"},"accept":"a/b"}') as Record<string, string>;
  const verdict = filterRequestHeaders(hostile);
  assert.deepEqual(verdict, { ok: true, headers: { accept: 'a/b' } });
  assert.equal(({} as Record<string, unknown>).authorization, undefined);
});

// ---------------------------------------------------------------------------
// Host -> Controller
// ---------------------------------------------------------------------------

test('the response allow-list is exactly the contract list (contracts section 7)', () => {
  assert.deepEqual([...RESPONSE_HEADER_ALLOW_LIST].sort(), ['accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'x-request-id']);
});

test('response: allow-listed headers pass; cache-control is always no-store', () => {
  const headers = filterResponseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': '27',
    'content-disposition': 'attachment; filename="Report.PDF"',
    'content-range': 'bytes 0-99/1000',
    'accept-ranges': 'bytes',
    etag: 'W/"abc"',
    'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-request-id': 'req-9',
  });
  assert.deepEqual(headers, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': '27',
    'content-disposition': 'attachment; filename="Report.PDF"',
    'content-range': 'bytes 0-99/1000',
    'accept-ranges': 'bytes',
    etag: 'W/"abc"',
    'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
    'cache-control': 'no-store',
    'x-request-id': 'req-9',
    'x-content-type-options': 'nosniff', // forced on every response, JSON included
  });
  assert.equal(filterResponseHeaders({ 'content-type': 'application/json' })['cache-control'], 'no-store');
});

test('response: Set-Cookie, X-Refreshed-Token, X-Auth-Error, Location and the Host CSP never reach the Controller (AC-26)', () => {
  const headers = filterResponseHeaders({
    'content-type': 'application/json',
    'set-cookie': ['sid=1; HttpOnly', 'b=2'],
    'x-refreshed-token': 'eyJ.NEW.TOKEN',
    'x-auth-error': 'session-expired',
    location: 'https://evil.example/',
    'content-location': '/x',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'",
    'content-security-policy-report-only': "default-src 'self'",
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'X-Refreshed-Token',
    'www-authenticate': 'Bearer',
    'strict-transport-security': 'max-age=1',
    'x-frame-options': 'ALLOWALL',
    'x-powered-by': 'Express',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    'content-encoding': 'gzip',
    upgrade: 'websocket',
    'proxy-authenticate': 'Basic',
    'clear-site-data': '"cache"',
    'service-worker-allowed': '/',
    refresh: '0;url=https://evil.example/',
    link: '</x>; rel=preload',
    vary: 'Origin',
    server: 'x',
    date: 'now',
    'retry-after': '5',
  });
  assert.deepEqual(Object.keys(headers).sort(), ['cache-control', 'content-type', 'x-content-type-options']);
});

test('response: array-valued allowed headers are joined, absurd values are dropped, a bad Content-Length is dropped', () => {
  const headers = filterResponseHeaders({ etag: ['"a"', '"b"'] as unknown as string, 'content-disposition': `attachment; filename="${'x'.repeat(9000)}"`, 'content-length': 'abc', 'x-request-id': 'ok' });
  assert.equal(headers.etag, '"a", "b"');
  assert.equal(headers['content-disposition'], undefined);
  assert.equal(headers['content-length'], undefined);
  assert.equal(headers['x-request-id'], 'ok');
  assert.equal(filterResponseHeaders({ 'content-length': '0' })['content-length'], '0');
  assert.equal(filterResponseHeaders({ 'content-length': '05' })['content-length'], undefined);
});

test('response: values that are undefined or empty arrays are ignored', () => {
  const headers = filterResponseHeaders({ etag: undefined, 'accept-ranges': [] as unknown as string, 'content-type': 'text/plain' });
  assert.deepEqual(Object.keys(headers).sort(), ['cache-control', 'content-type', 'x-content-type-options', 'content-security-policy'].sort());
});

const JSON_OR_SSE = [
  'application/json',
  'application/json; charset=utf-8',
  'APPLICATION/JSON',
  'Application/Json;charset=UTF-8',
  'application/problem+json',
  'application/vnd.api+json; charset=utf-8',
  'text/event-stream',
  'text/event-stream; charset=utf-8',
  'TEXT/EVENT-STREAM',
  // Parameters never change the media type: these stay exempt from the CSP but still get nosniff.
  'application/json;charset=utf-7',
  'application/json; charset=utf-7',
  'text/event-stream;charset=x',
  'application/problem+json; charset=utf-7',
];

const NOT_JSON_OR_SSE = [
  undefined,
  '',
  'text/html',
  'text/html; charset=utf-8',
  'TEXT/HTML',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/plain',
  'text/xml',
  'application/xml',
  'application/javascript',
  'text/javascript',
  'application/pdf',
  'application/octet-stream',
  'multipart/mixed; boundary=x',
  'application/jsonp',
  'application/json-evil',
  'application/jsonx',
  'text/html; x=application/json',
  'text/html, application/json',
  'application/x-json',
  'text/event-streamx',
  'text/event-stream-evil',
  'image/png',
];

test('isJsonOrEventStream recognises JSON and SSE only (exact media types, parameters ignored)', () => {
  for (const type of JSON_OR_SSE) assert.equal(isJsonOrEventStream(type), true, type);
  for (const type of NOT_JSON_OR_SSE) assert.equal(isJsonOrEventStream(type), false, String(type));
});

test('response: JSON and SSE get nosniff but no CSP sandbox (the contract keeps the sandbox for other types)', () => {
  for (const type of JSON_OR_SSE) {
    const headers = filterResponseHeaders({ 'content-type': type });
    assert.deepEqual(Object.keys(headers).sort(), ['cache-control', 'content-type', 'x-content-type-options'], type);
    assert.equal(headers['x-content-type-options'], 'nosniff', type);
  }
});

test('response: nosniff is on EVERY response, whatever the status line says about the body (no content-type, empty headers, JSON, SSE)', () => {
  const samples: Array<Record<string, string | string[] | undefined>> = [
    {},
    { 'content-type': '' },
    { 'content-type': 'application/json' },
    { 'content-type': 'application/problem+json' },
    { 'content-type': 'application/json;charset=utf-7' },
    { 'content-type': 'text/event-stream;charset=x' },
    { 'content-type': ['application/json', 'text/html'] as unknown as string },
    { 'content-type': 'text/html' },
    { 'x-content-type-options': 'sniff', 'content-type': 'application/json' }, // the Host's own value never wins
  ];
  for (const sample of samples) {
    const headers = filterResponseHeaders(sample);
    assert.equal(headers['x-content-type-options'], 'nosniff', JSON.stringify(sample));
    assert.equal(headers['cache-control'], 'no-store', JSON.stringify(sample));
  }
});

test('response: the CSP sandbox is absent exactly for JSON and SSE and present for a missing or unusual content-type', () => {
  for (const type of JSON_OR_SSE) assert.equal(filterResponseHeaders({ 'content-type': type })['content-security-policy'], undefined, type);
  for (const sample of [{}, { 'content-type': '' }, { 'content-type': 'text/json' }, { 'content-type': 'application/jsonp' }, { 'content-type': 'application/vnd.api+xml' }]) {
    assert.equal(filterResponseHeaders(sample)['content-security-policy'], SANDBOX_CSP, JSON.stringify(sample));
  }
});

test('response: anything else is forced to nosniff + CSP sandbox (Host content is untrusted in the Controller origin)', () => {
  assert.equal(SANDBOX_CSP, "sandbox; default-src 'none'");
  for (const type of NOT_JSON_OR_SSE) {
    const headers = filterResponseHeaders(type === undefined ? {} : { 'content-type': type });
    assert.equal(headers['x-content-type-options'], 'nosniff', String(type));
    assert.equal(headers['content-security-policy'], "sandbox; default-src 'none'", String(type));
    assert.equal(headers['cache-control'], 'no-store');
  }
});

test('response: a text/html file opened top-level cannot run script: the sandbox has no allow-scripts and the Host CSP is gone', () => {
  const headers = filterResponseHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "script-src 'unsafe-inline'",
    'content-disposition': 'inline; filename="evil.html"',
  });
  const csp = String(headers['content-security-policy']);
  assert.match(csp, /^sandbox;/);
  assert.ok(!csp.includes('allow-'), csp);
  assert.ok(csp.includes("default-src 'none'"));
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['content-disposition'], 'inline; filename="evil.html"');
});
