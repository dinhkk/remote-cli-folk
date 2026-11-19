import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { afterEach, beforeEach, test } from 'vitest';

import {
  installServiceWorkerStub,
  installStorageShim,
} from '@/shared/transport/storage-shim';

/**
 * Inside the sandbox (no allow-same-origin) touching the real localStorage,
 * sessionStorage, document.cookie or navigator.serviceWorker throws a
 * SecurityError, and chatDrafts.ts reads localStorage at module scope. So the
 * shim replaces all of them with in-memory objects, mirrors every write to the
 * Controller over the MessagePort, and must be in place before any import and
 * before the inline service-worker script of index.html.
 */

type Descriptors = Record<string, PropertyDescriptor | undefined>;
let saved: Descriptors = {};

const remember = () => {
  saved = {
    localStorage: Object.getOwnPropertyDescriptor(window, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(window, 'sessionStorage'),
    cookie: Object.getOwnPropertyDescriptor(document, 'cookie'),
    serviceWorker: Object.getOwnPropertyDescriptor(navigator, 'serviceWorker'),
  };
};
const restore = () => {
  const targets: Array<[string, object]> = [
    ['localStorage', window],
    ['sessionStorage', window],
    ['cookie', document],
    ['serviceWorker', navigator],
  ];
  for (const [name, target] of targets) {
    const descriptor = saved[name];
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  }
};

beforeEach(remember);
afterEach(restore);

test('the shim storage implements the basic Storage API with string coercion', () => {
  installStorageShim();
  const store = window.localStorage;

  assert.equal(store.length, 0);
  assert.equal(store.getItem('a'), null);
  store.setItem('a', 1 as unknown as string);
  store.setItem('b', 'two');
  assert.equal(store.getItem('a'), '1');
  assert.equal(store.length, 2);
  assert.deepEqual([store.key(0), store.key(1), store.key(2)], ['a', 'b', null]);
  store.removeItem('a');
  assert.equal(store.getItem('a'), null);
  store.clear();
  assert.equal(store.length, 0);
});

test('property access reaches the same entries as the methods', () => {
  installStorageShim();
  const store = window.localStorage;
  store.setItem('theme', 'dark');

  assert.equal((store as unknown as Record<string, string>).theme, 'dark');
  (store as unknown as Record<string, string>).lang = 'vi';
  assert.equal(store.getItem('lang'), 'vi');
  assert.deepEqual(Object.keys(store).sort(), ['lang', 'theme']);
  delete (store as unknown as Record<string, string>).lang;
  assert.equal(store.getItem('lang'), null);
});

test('installStorageShim replaces both storages with memory and leaves the real one untouched', () => {
  localStorage.setItem('real-key', 'real-value');
  const realLocal = window.localStorage;

  installStorageShim();

  assert.notEqual(window.localStorage, realLocal);
  assert.equal(window.localStorage.getItem('real-key'), null, 'the shim must not expose real storage');
  window.localStorage.setItem('activeTab', 'git');
  assert.equal(window.localStorage.getItem('activeTab'), 'git');
  assert.equal(realLocal.getItem('activeTab'), null, 'writes must not reach real storage');
  assert.equal(realLocal.getItem('real-key'), 'real-value');
  window.sessionStorage.setItem('s', '1');
  assert.equal(window.localStorage.getItem('s'), null, 'the two areas stay separate');
  realLocal.clear();
});

test('every write is mirrored to the parent tagged with its area', () => {
  const shim = installStorageShim();
  const writes: unknown[] = [];
  shim.setWriteListener((write) => writes.push(write));

  window.localStorage.setItem('permissionMode', 'plan');
  window.localStorage.removeItem('permissionMode');
  window.localStorage.setItem('x', '1');
  window.localStorage.clear();
  window.sessionStorage.setItem('tab', 'chat');

  assert.deepEqual(writes, [
    { area: 'local', key: 'permissionMode', value: 'plan' },
    { area: 'local', key: 'permissionMode', value: null },
    { area: 'local', key: 'x', value: '1' },
    { area: 'local', key: null, value: null },
    { area: 'session', key: 'tab', value: 'chat' },
  ]);
});

test('the initial snapshot fills the shim without echoing back to the parent', () => {
  const shim = installStorageShim();
  const writes: unknown[] = [];
  shim.setWriteListener((write) => writes.push(write));

  shim.loadSnapshot({ local: { activeTab: 'files', permissionMode: 'acceptEdits' }, session: { s: '1' } });

  assert.equal(window.localStorage.getItem('activeTab'), 'files');
  assert.equal(window.sessionStorage.getItem('s'), '1');
  assert.deepEqual(writes, []);
});

test('a reload keeps activeTab and permissionMode by replaying what the parent stored', () => {
  const first = installStorageShim();
  const stored: Record<string, string> = {};
  first.setWriteListener((write) => {
    if (write.area === 'local' && write.key && write.value !== null) stored[write.key] = write.value;
  });
  window.localStorage.setItem('activeTab', 'git');
  window.localStorage.setItem('permissionMode', 'plan');

  // A fresh document: new shim, same snapshot from the parent.
  const second = installStorageShim();
  second.loadSnapshot({ local: stored, session: {} });

  assert.equal(window.localStorage.getItem('activeTab'), 'git');
  assert.equal(window.localStorage.getItem('permissionMode'), 'plan');
});

test('document.cookie reads empty and ignores writes instead of throwing', () => {
  installStorageShim();

  document.cookie = 'a=b';

  assert.equal(document.cookie, '');
});

test('the service worker stub can be read, listened to and queried but never registers', async () => {
  installServiceWorkerStub();
  const sw = navigator.serviceWorker;

  assert.equal(sw.controller, null);
  await assert.rejects(() => sw.register('/sw.js'));
  assert.equal(await sw.getRegistration(), undefined);
  assert.deepEqual(await sw.getRegistrations(), []);
  sw.addEventListener('message', () => undefined);
  sw.removeEventListener('message', () => undefined);
  let readySettled = false;
  void sw.ready.then(() => {
    readySettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readySettled, false, 'ready must stay pending');
});

// ---------------------------------------------------------------------------
// Ordering: the shim has to exist before anything that would touch storage
// ---------------------------------------------------------------------------

test('main.tsx loads the transport bootstrap first and the app only after it settled', () => {
  const source = readFileSync('src/main.tsx', 'utf8');
  const imports = source.match(/^import .*$/gm) ?? [];

  // The only static imports are the bootstrap and the failure screen: nothing that touches storage.
  assert.equal(imports.length, 2);
  assert.ok(imports.some((line) => /@\/shared\/transport\/target-bootstrap/.test(line)));
  assert.equal(/^import .*@\/App/m.test(source), false, 'the app must not be a static import of main.tsx');
  assert.match(source, /prepareTargetMode\(\)[\s\S]*import\('@\/app-entry'\)[\s\S]*\.catch\(renderBootFailure\)/);
});

const readIndexHtml = () => readFileSync('index.html', 'utf8');
type InlineScript = { tag: string; body: string };
const inlineScripts = (html: string): InlineScript[] =>
  Array.from(html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g), (match) => ({
    tag: match[1] as string,
    body: match[2] as string,
  }));
const findShim = (html: string) =>
  inlineScripts(html).find((script) => script.tag.includes('data-cloudcli-target-shim'))?.body;
const findServiceWorkerScript = (html: string) =>
  inlineScripts(html).find((script) => script.body.includes("register('/sw.js'"))?.body;

test('index.html carries an inline shim in <head>, ahead of the service-worker script', () => {
  const html = readIndexHtml();
  const headEnd = html.indexOf('</head>');
  const scripts = inlineScripts(html);
  const shimIndex = html.indexOf('data-cloudcli-target-shim');
  const swIndex = html.indexOf("navigator.serviceWorker.register('/sw.js'");

  assert.ok(shimIndex > -1 && shimIndex < headEnd, 'the shim must sit inside <head>');
  assert.ok(shimIndex < swIndex, 'the shim must run before the inline service-worker script');
  assert.ok(scripts.length >= 2);
  assert.match(html, /register\('\/sw\.js', \{ updateViaCache: 'none' \}\)/);
});

const makeSandboxWindow = (search: string, name = '', framed = true) => {
  const throwing = () => {
    throw new Error('SecurityError');
  };
  const win: Record<string, unknown> = { name, location: { search }, document: {}, __registered: 0 };
  win.parent = framed ? {} : win;
  const nav: Record<string, unknown> = {};
  Object.defineProperty(win, 'localStorage', { get: throwing, configurable: true });
  Object.defineProperty(win, 'sessionStorage', { get: throwing, configurable: true });
  Object.defineProperty(win.document, 'cookie', { get: throwing, set: throwing, configurable: true });
  Object.defineProperty(nav, 'serviceWorker', { get: throwing, configurable: true });
  win.navigator = nav;
  win.addEventListener = () => undefined;
  win.window = win;
  return { win, nav };
};

const runInline = (script: string, win: Record<string, unknown>, nav: Record<string, unknown>) => {
  vm.runInNewContext(script, { window: win, navigator: nav, document: win.document, console });
};

test('the inline shim makes a sandboxed document survive its first reads, then the sw script stays quiet', async () => {
  const html = readIndexHtml();
  const shimScript = findShim(html);
  const swScript = findServiceWorkerScript(html);
  assert.ok(shimScript && swScript);

  const { win, nav } = makeSandboxWindow('?target=peer_abc12345');
  runInline(shimScript, win, nav);

  assert.equal((win.localStorage as Storage).getItem('x'), null);
  assert.doesNotThrow(() => (win.sessionStorage as Storage).setItem('x', '1'));
  assert.equal((win.document as { cookie: string }).cookie, '');
  const sw = nav.serviceWorker as { register: () => Promise<unknown> };
  await assert.rejects(() => sw.register());

  // The registration script must not even try in a tab.
  let registrations = 0;
  (nav.serviceWorker as { register: () => Promise<unknown> }).register = () => {
    registrations += 1;
    return Promise.resolve();
  };
  const listeners: Array<() => void> = [];
  win.addEventListener = (_type: string, listener: () => void) => listeners.push(listener);
  runInline(swScript, win, nav);
  listeners.forEach((listener) => listener());
  assert.equal(registrations, 0);
});

const shimInstalled = (win: Record<string, unknown>) => win.__CLOUDCLI_TARGET__ === true;

test('a top-level page is never shimmed, whatever its query or window.name says', () => {
  const shimScript = findShim(readIndexHtml());
  assert.ok(shimScript);

  for (const [search, name] of [
    ['?target=peer_abc12345', ''],
    ['', 'cloudcli-target:peer_abc12345'],
    ['?target=peer_abc12345', 'cloudcli-target:peer_abc12345'],
  ] as const) {
    const { win, nav } = makeSandboxWindow(search, name, false);
    runInline(shimScript, win, nav);

    assert.equal(shimInstalled(win), false, `${search} ${name}`);
    assert.throws(() => win.localStorage, /SecurityError/, 'real storage must be left alone');
  }
});

test('the inline shim uses the same rules as the app: valid ids only, the query wins over window.name', () => {
  const shimScript = findShim(readIndexHtml());
  assert.ok(shimScript);

  const cases: Array<[string, string, boolean]> = [
    ['?target=peer_abc12345', '', true],
    ['', 'cloudcli-target:peer_abc12345', true],
    ['', 'cloudcli-target:../evil', false],
    ['', 'cloudcli-target:', false],
    ['', 'cloudcli-target:' + 'x'.repeat(65), false],
    ['?target=bad!', '', false],
    ['?target=bad!&target=ok', '', false],
    ['?target=', 'cloudcli-target:peer_abc12345', false],
    ['?target=ok&target=bad!', '', true],
    ['?x=1&target=peer_abc12345', '', true],
    ['?notarget=peer_abc12345', '', false],
  ];
  for (const [search, name, expected] of cases) {
    const { win, nav } = makeSandboxWindow(search, name);
    runInline(shimScript, win, nav);
    assert.equal(shimInstalled(win), expected, `${JSON.stringify(search)} ${JSON.stringify(name)}`);
  }
});

test('outside a tab the inline shim does nothing and the sw script still registers', () => {
  const html = readIndexHtml();
  const shimScript = findShim(html);
  const swScript = findServiceWorkerScript(html);
  assert.ok(shimScript && swScript);

  const win: Record<string, unknown> = { name: '', location: { search: '' }, document: {} };
  win.window = win;
  let registrations = 0;
  const nav = { serviceWorker: { register: () => { registrations += 1; return Promise.resolve({}); } } };
  runInline(shimScript, win, nav as unknown as Record<string, unknown>);
  assert.equal('localStorage' in win, false, 'the shim must leave a normal document alone');

  const listeners: Array<() => void> = [];
  win.addEventListener = (_type: string, listener: () => void) => listeners.push(listener);
  runInline(swScript, win, nav as unknown as Record<string, unknown>);
  listeners.forEach((listener) => listener());
  assert.equal(registrations, 1);
});
