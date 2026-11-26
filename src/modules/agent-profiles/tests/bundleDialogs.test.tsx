import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { AgentProfilesPanel } from '@/modules/agent-profiles';
import { ExportBundleDialog } from '@/modules/agent-profiles/bundle/ExportBundleDialog';
import { ImportBundleDialog } from '@/modules/agent-profiles/bundle/ImportBundleDialog';
import { RestoreSnapshotDialog } from '@/modules/agent-profiles/bundle/RestoreSnapshotDialog';
import {
  REVIEW_TEMPLATE,
  ORCHESTRATOR_TEMPLATE,
  SIDEBAR_ALPHA,
  SIDEBAR_CRM,
  failure,
  installFakeProfilesApi,
  listing,
  makeFolderRow,
  makeImportResult,
  makeMemoryBlock,
  makePlanItem,
  memoryBlockRoutes,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { ImportPlan } from '@/shared/types';

/**
 * The bundle dialogs against a fake server: export (defaults, request, download), import (paste and file, preview table,
 * ticks, folder mapping, basis, errors, result), and restore (newest first, confirm step).
 */

const PREVIEW = '/api/agent-profiles/bundle/import/preview';
const IMPORT = '/api/agent-profiles/bundle/import';
const EXPORT = '/api/agent-profiles/bundle/export';
const SNAPSHOTS = '/api/agent-profiles/bundle/snapshots';
const RESTORE = '/api/agent-profiles/bundle/restore';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** The element as a form control, for reading `checked`, `disabled` and `value`. */
const box = (element: HTMLElement | null): HTMLInputElement => element as HTMLInputElement;

const readBlob = (blob: Blob): Promise<string> => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.readAsText(blob);
});

const planOf = (items: ImportPlan['items'], hasFolderText = false): ImportPlan => ({ items, hasFolderText });

const pasteAndPreview = async (text = 'format: remotecli.agent-bundle') => {
  fireEvent.change(screen.getByLabelText(/paste the bundle text/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByRole('table');
};

const renderImport = (plan: ImportPlan, options: { projects?: typeof SIDEBAR_ALPHA[]; result?: ReturnType<typeof makeImportResult>; onApplied?: () => void } = {}) => {
  const api = installFakeProfilesApi({
    [`POST ${PREVIEW}`]: reply(plan),
    [`POST ${IMPORT}`]: reply(options.result ?? makeImportResult()),
  });
  render(<ImportBundleDialog projects={options.projects ?? [SIDEBAR_ALPHA, SIDEBAR_CRM]} onClose={() => {}} onApplied={options.onApplied ?? (() => {})} />);
  return api;
};

describe('ExportBundleDialog', () => {
  let downloads: string[];
  let blobs: Blob[];
  beforeEach(() => {
    downloads = [];
    blobs = [];
    // jsdom has no object URLs; they are installed per test and removed again afterwards.
    URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return 'blob:fake'; };
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });
  });

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  const renderExport = (exportReply = reply({ filename: 'remotecli-agent-bundle-20261126.yaml', text: 'a: 1\n', problems: [] })) => {
    const { routes } = memoryBlockRoutes([makeMemoryBlock({ id: 'b-1', name: 'notes' })]);
    const api = installFakeProfilesApi({ ...routes, [`POST ${EXPORT}`]: exportReply });
    render(<ExportBundleDialog templates={[REVIEW_TEMPLATE, ORCHESTRATOR_TEMPLATE]} onClose={() => {}} />);
    return api;
  };

  it('defaults to block text off and YAML, warns about private content, and lists templates and blocks', async () => {
    renderExport();
    await screen.findByRole('checkbox', { name: 'notes' });
    expect(box(screen.getByRole('checkbox', { name: /include block text/i })).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: /include block text/i }).closest('label')?.textContent).toMatch(/every folder/i);
    expect(box(screen.getByRole('radio', { name: /YAML/ })).checked).toBe(true);
    expect(box(screen.getByRole('radio', { name: /JSON/ })).checked).toBe(false);
    expect(screen.getByText(/may be private/i)).not.toBeNull();
    expect(box(screen.getByRole('checkbox', { name: 'Code reviewer' })).checked).toBe(true);
  });

  it('sends the chosen items and downloads the returned file under the returned name', async () => {
    const api = renderExport();
    await screen.findByRole('checkbox', { name: 'notes' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Orchestrator' }));
    fireEvent.click(screen.getByRole('radio', { name: /JSON/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /include block text/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(downloads).toEqual(['remotecli-agent-bundle-20261126.yaml']));
    expect(api.to('POST', EXPORT)[0]!.body).toEqual({ templateIds: ['t-review'], blockIds: ['b-1'], includeBlockContent: true, format: 'json' });
    expect(await readBlob(blobs[0]!)).toBe('a: 1\n');
  });

  it('shows the problems the server reports', async () => {
    renderExport(reply({ filename: 'x.yaml', text: '', problems: [{ key: 'block:notes', code: 'BLOCK_NOT_MIGRATED', message: 'Block notes was left out' }] }));
    await screen.findByRole('checkbox', { name: 'notes' });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Block notes was left out/)).not.toBeNull();
  });
});

describe('ImportBundleDialog: input', () => {
  it('previews pasted text and sends it to the server', async () => {
    const api = renderImport(planOf([makePlanItem({ key: 'template:alpha' })]));
    await pasteAndPreview('hello: world');
    expect(api.to('POST', PREVIEW)[0]!.body).toEqual({ text: 'hello: world' });
  });

  it('previews the content of a chosen file', async () => {
    const api = renderImport(planOf([makePlanItem({ key: 'template:alpha' })]));
    const file = new File(['templates: []\n'], 'bundle.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [file] } });
    await waitFor(() => expect(box(screen.getByLabelText(/paste the bundle text/i)).value).toBe('templates: []\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('table');
    expect(api.to('POST', PREVIEW)[0]!.body).toEqual({ text: 'templates: []\n' });
  });

  it('refuses text over 5 MB on the client without calling the server', () => {
    const api = renderImport(planOf([]));
    fireEvent.change(screen.getByLabelText(/paste the bundle text/i), { target: { value: 'a'.repeat(5 * 1024 * 1024 + 1) } });
    expect((screen.getByRole('alert')).textContent).toMatch(/5 MB/);
    expect(box(screen.getByRole('button', { name: 'Preview' })).disabled).toBe(true);
    expect(api.to('POST', PREVIEW)).toHaveLength(0);
  });

  it('refuses a file over 5 MB without reading it', () => {
    renderImport(planOf([]));
    const big = new File(['x'], 'big.yaml');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [big] } });
    expect((screen.getByRole('alert')).textContent).toMatch(/5 MB/);
    expect(box(screen.getByLabelText(/paste the bundle text/i)).value).toBe('');
  });

  it('shows line, column and path of a syntax error', async () => {
    installFakeProfilesApi({ [`POST ${PREVIEW}`]: failure(400, 'BUNDLE_INVALID', 'bad indentation', { line: 4, column: 7, path: 'templates[0]' }) });
    render(<ImportBundleDialog projects={[]} onClose={() => {}} onApplied={() => {}} />);
    fireEvent.change(screen.getByLabelText(/paste the bundle text/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const alert = await screen.findByRole('alert');
    expect((alert).textContent).toMatch(/line 4, column 7/i);
    expect((alert).textContent).toContain('templates[0]');
    expect((alert).textContent).toContain('bad indentation');
  });
});

describe('ImportBundleDialog: preview table and ticks', () => {
  const ITEMS = [
    makePlanItem({ key: 'template:alpha' }),
    makePlanItem({ key: 'template:beta', status: 'identical', code: 'IDENTICAL' }),
    makePlanItem({ key: 'template:gamma', status: 'conflict', code: 'CONFLICT', overwritable: true, basis: 4 }),
    makePlanItem({
      key: 'template:delta',
      status: 'invalid',
      problems: [{ level: 'error', code: 'X', message: 'Slug is not valid', line: 2, column: 3 }],
    }),
  ];

  it('lists each item with its status and problems including line and column', async () => {
    renderImport(planOf(ITEMS));
    await pasteAndPreview();
    const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
    expect(within(row('alpha')).getByText('New')).not.toBeNull();
    expect(within(row('beta')).getByText('Identical')).not.toBeNull();
    expect(within(row('gamma')).getByText('Conflict')).not.toBeNull();
    expect(within(row('delta')).getByText('Invalid')).not.toBeNull();
    expect(within(row('delta')).getByText(/Slug is not valid/)).not.toBeNull();
    expect(within(row('delta')).getByText(/line 2, column 3/i)).not.toBeNull();
  });

  it('does not overwrite a conflict unless it is ticked, and sends the basis of the ticked row', async () => {
    const api = renderImport(planOf(ITEMS));
    await pasteAndPreview();
    expect(box(screen.getByRole('checkbox', { name: 'Overwrite gamma' })).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.to('POST', IMPORT)).toHaveLength(1));
    expect(api.to('POST', IMPORT)[0]!.body).toMatchObject({ overwrite: [], basis: {} });
  });

  it('sends the overwrite tick with the basis copied from the preview', async () => {
    const api = renderImport(planOf(ITEMS));
    await pasteAndPreview();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overwrite gamma' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.to('POST', IMPORT)).toHaveLength(1));
    expect(api.to('POST', IMPORT)[0]!.body).toEqual({
      text: 'format: remotecli.agent-bundle', overwrite: ['template:gamma'], acceptSensitive: [], projectMap: {}, basis: { 'template:gamma': 4 },
    });
  });

  it('disables the tick of a conflict that can never be overwritten and says why', async () => {
    renderImport(planOf([
      makePlanItem({ key: 'block:alpha', status: 'conflict', code: 'BLOCK_SCOPE_IMMUTABLE', overwritable: false }),
    ]));
    await pasteAndPreview();
    expect(box(screen.getByRole('checkbox', { name: 'Overwrite alpha' })).disabled).toBe(true);
    expect((screen.getByRole('row', { name: /alpha/ })).textContent).toMatch(/other scope kind/i);
  });

  it('needs a tick per sensitive item, offers Select all sensitive, and ticks nothing by default', async () => {
    const api = renderImport(planOf([
      makePlanItem({ key: 'template:alpha', sensitive: ['mcpServers', 'tool:Bash'] }),
      makePlanItem({ key: 'template:beta', sensitive: ['skills'] }),
      makePlanItem({ key: 'template:gamma' }),
    ]));
    await pasteAndPreview();
    const alpha = screen.getByRole('checkbox', { name: 'Allow sensitive alpha' });
    const beta = screen.getByRole('checkbox', { name: 'Allow sensitive beta' });
    expect(screen.queryByRole('checkbox', { name: 'Allow sensitive gamma' })).toBeNull();
    expect(box(alpha).checked).toBe(false);
    expect(box(beta).checked).toBe(false);
    expect(within(screen.getByRole('row', { name: /alpha/ })).getAllByText(/sensitive/i).length).toBeGreaterThan(0);
    fireEvent.click(alpha);
    expect(box(beta).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Select all sensitive' }));
    expect(box(alpha).checked).toBe(true);
    expect(box(beta).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.to('POST', IMPORT)).toHaveLength(1));
    expect(api.to('POST', IMPORT)[0]!.body).toMatchObject({ acceptSensitive: ['template:alpha', 'template:beta'] });
  });
});

describe('ImportBundleDialog: folders', () => {
  const FOLDER_PLAN = planOf([
    makePlanItem({
      key: 'block:alpha',
      folders: [
        makeFolderRow({ key: 'block:alpha#k1', sourceKey: 'k1', sourceDirectory: '/src/one' }),
        makeFolderRow({ key: 'block:alpha#k2', sourceKey: 'k2', sourceDirectory: '/src/two', status: 'conflict', overwritable: true, basis: 6 }),
      ],
    }),
    makePlanItem({ key: 'block:beta', folders: [makeFolderRow({ key: 'block:beta#k1', sourceKey: 'k1', sourceDirectory: '/src/one', status: 'identical' })] }),
  ], true);

  it('shows no folder mapping when the bundle has no folder text', async () => {
    renderImport(planOf([makePlanItem({ key: 'template:alpha' })]));
    await pasteAndPreview();
    expect(screen.queryByText(/map folders/i)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows one mapping row per distinct source folder and the folder rows of each block', async () => {
    renderImport(FOLDER_PLAN);
    await pasteAndPreview();
    expect(screen.getAllByRole('combobox', { name: /project for \/src\/one/i })).toHaveLength(1);
    expect(screen.getAllByRole('combobox', { name: /project for \/src\/two/i })).toHaveLength(1);
    expect(box(screen.getByRole('checkbox', { name: 'Overwrite folder /src/two of alpha' })).checked).toBe(false);
    expect(box(screen.getByRole('checkbox', { name: 'Overwrite folder /src/two of alpha' })).disabled).toBe(false);
  });

  it('previews again with the chosen project id and sends it on apply together with the folder basis', async () => {
    const api = renderImport(FOLDER_PLAN);
    await pasteAndPreview();
    fireEvent.change(screen.getByRole('combobox', { name: /project for \/src\/one/i }), { target: { value: 'sp-alpha' } });
    await waitFor(() => expect(api.to('POST', PREVIEW)).toHaveLength(2));
    expect(api.to('POST', PREVIEW)[1]!.body).toEqual({ text: 'format: remotecli.agent-bundle', projectMap: { k1: 'sp-alpha' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Overwrite folder /src/two of alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.to('POST', IMPORT)).toHaveLength(1));
    expect(api.to('POST', IMPORT)[0]!.body).toMatchObject({
      projectMap: { k1: 'sp-alpha' }, overwrite: ['block:alpha#k2'], basis: { 'block:alpha#k2': 6 },
    });
  });

  it('leaves an unmapped folder on Skip, sends no mapping for it and still lets the block apply', async () => {
    const api = renderImport(FOLDER_PLAN);
    await pasteAndPreview();
    expect(box(screen.getByRole('combobox', { name: /project for \/src\/one/i })).value).toBe('');
    expect(box(screen.getByRole('button', { name: 'Apply' })).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.to('POST', IMPORT)).toHaveLength(1));
    expect(api.to('POST', IMPORT)[0]!.body).toMatchObject({ projectMap: {} });
  });

  it('notes that a project block without folder text is seen only in folders that have text', async () => {
    renderImport(planOf([makePlanItem({ key: 'block:alpha', scope: 'project' })]));
    await pasteAndPreview();
    expect(screen.getByText(/add folders in the Memory tab/i)).not.toBeNull();
  });

  it('does not show that note for a global block', async () => {
    renderImport(planOf([makePlanItem({ key: 'block:beta', scope: 'global' })]));
    await pasteAndPreview();
    expect(screen.queryByText(/add folders in the Memory tab/i)).toBeNull();
  });
});

describe('ImportBundleDialog: result', () => {
  const PLAN = planOf([makePlanItem({ key: 'template:alpha' }), makePlanItem({ key: 'template:beta' })]);

  it('lists the outcome per item, refreshes the panel and disables Apply until Preview again', async () => {
    const onApplied = vi.fn();
    const api = renderImport(PLAN, {
      onApplied,
      result: makeImportResult({ items: [{ key: 'template:alpha', status: 'applied' }, { key: 'template:beta', status: 'skipped', code: 'IDENTICAL' }] }),
    });
    await pasteAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const list = await screen.findByRole('list', { name: /result/i });
    expect(within(list).getByText(/alpha/)).not.toBeNull();
    expect(within(list).getByText(/beta/)).not.toBeNull();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(box(screen.getByRole('button', { name: 'Apply' })).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(api.to('POST', PREVIEW)).toHaveLength(2));
    await waitFor(() => expect(box(screen.getByRole('button', { name: 'Apply' })).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Preview again' })).toBeNull();
  });

  it('warns on a partial result and names the snapshot with the restore note', async () => {
    renderImport(PLAN, {
      result: makeImportResult({
        partial: true,
        snapshot: 'snapshot-20261126-101500.json',
        items: [{ key: 'template:alpha', status: 'failed', code: 'STALE' }, { key: 'template:beta', status: 'applied' }],
      }),
    });
    await pasteAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/were not applied/i)).not.toBeNull();
    expect(screen.getByText(/snapshot-20261126-101500\.json/)).not.toBeNull();
    expect(screen.getByText(/Restore list/)).not.toBeNull();
    expect(screen.getByText(/changed since the preview/i)).not.toBeNull();
  });

  it('shows no warning for a complete result', async () => {
    renderImport(PLAN, { result: makeImportResult({ items: [{ key: 'template:alpha', status: 'applied' }] }) });
    await pasteAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('list', { name: /result/i });
    expect(screen.queryByText(/were not applied/i)).toBeNull();
  });
});

describe('RestoreSnapshotDialog', () => {
  const OLD = { name: 'snapshot-old.json', createdAt: '2026-11-01T08:00:00.000Z', templates: 1, blocks: 2, folders: 0, bytes: 2048 };
  const NEW = { name: 'snapshot-new.json', createdAt: '2026-11-25T08:00:00.000Z', templates: 3, blocks: 4, folders: 5, bytes: 4096 };

  it('lists snapshots newest first and asks for confirmation before restoring', async () => {
    const onApplied = vi.fn();
    const api = installFakeProfilesApi({
      [`GET ${SNAPSHOTS}`]: reply([OLD, NEW]),
      [`POST ${RESTORE}`]: reply(makeImportResult({ items: [{ key: 'template:alpha', status: 'applied' }], snapshot: 'snapshot-fresh.json' })),
    });
    render(<RestoreSnapshotDialog onClose={() => {}} onApplied={onApplied} />);
    const rows = await screen.findAllByRole('listitem');
    expect((rows[0]).textContent).toContain('snapshot-new.json');
    expect((rows[1]).textContent).toContain('snapshot-old.json');
    expect((rows[0]).textContent).toContain('3');
    expect(screen.getByText(/created since are kept/i)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Restore snapshot-new.json' }));
    expect(api.to('POST', RESTORE)).toHaveLength(0);
    expect(screen.getByText(/replace the current ones/i)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(api.to('POST', RESTORE)).toHaveLength(1));
    expect(api.to('POST', RESTORE)[0]!.body).toEqual({ snapshot: 'snapshot-new.json' });
    expect((await screen.findByRole('list', { name: /result/i })).textContent).toMatch(/alpha/);
    expect(screen.getByText(/snapshot-fresh\.json/)).not.toBeNull();
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('lets the user back out of the confirmation', async () => {
    const api = installFakeProfilesApi({ [`GET ${SNAPSHOTS}`]: reply([NEW]) });
    render(<RestoreSnapshotDialog onClose={() => {}} onApplied={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore snapshot-new.json' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull();
    expect(api.to('POST', RESTORE)).toHaveLength(0);
  });

  it('says so when there are no snapshots and explains an unavailable one', async () => {
    installFakeProfilesApi({ [`GET ${SNAPSHOTS}`]: reply([]) });
    render(<RestoreSnapshotDialog onClose={() => {}} onApplied={() => {}} />);
    expect(await screen.findByText(/no snapshots yet/i)).not.toBeNull();
  });

  it('shows a refused restore in place', async () => {
    installFakeProfilesApi({
      [`GET ${SNAPSHOTS}`]: reply([NEW]),
      [`POST ${RESTORE}`]: failure(409, 'SNAPSHOT_UNAVAILABLE', 'unavailable'),
    });
    render(<RestoreSnapshotDialog onClose={() => {}} onApplied={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore snapshot-new.json' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be read|unavailable/i);
  });
});

describe('AgentProfilesPanel header', () => {
  it('opens the three dialogs and reloads the templates after an import', async () => {
    localStorage.setItem('agentProfiles.setupGuideDismissed', '1');
    const { routes } = memoryBlockRoutes();
    const api = installFakeProfilesApi({
      ...routes,
      'GET /api/agent-profiles/templates': reply({ items: [REVIEW_TEMPLATE], corrupt: [] }),
      'GET /api/agent-profiles/claude-agents': reply(listing([])),
      [`GET ${SNAPSHOTS}`]: reply([]),
      [`POST ${PREVIEW}`]: reply(planOf([makePlanItem({ key: 'template:alpha' })])),
      [`POST ${IMPORT}`]: reply(makeImportResult({ items: [{ key: 'template:alpha', status: 'applied' }] })),
    });
    render(<AgentProfilesPanel projects={[SIDEBAR_ALPHA]} />);
    await waitFor(() => expect(api.to('GET', '/api/agent-profiles/templates')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText(/no snapshots yet/i)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await pasteAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('list', { name: /result/i });
    await waitFor(() => expect(api.to('GET', '/api/agent-profiles/templates')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('checkbox', { name: 'Code reviewer' })).not.toBeNull();
  });
});
