import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type * as TargetContextModule from '@/shared/transport/target-context';

type TargetContext = typeof TargetContextModule;

const targetMode = vi.hoisted(() => ({ value: false }));
vi.mock('@/shared/transport/target-context', async (importOriginal) => ({
  ...(await importOriginal<TargetContext>()),
  isTargetMode: () => targetMode.value,
}));

const { default: HtmlPreview } = await import('@/modules/code-editor/preview/HtmlPreview');
const { isBlockedInTargetMode } = await import('@/shared/transport/target-route-policy');

const SOURCE = { projectId: 'p1', filePath: '/repo/site/index.html' };
const PREVIEW_URL = '/api/file-tree/projects/p1/files/html-preview?path=%2Frepo%2Fsite%2Findex.html';
const EDITOR_TEXT = '<p>editor text</p><script>parent.document.title = "x"</script>';

// The status check. A 200 body never ends (a large file): the check must drop it, not read it. An error is
// the server's small JSON answer.
function stubCheck(status: number) {
  const cancelled = vi.fn();
  const fetchMock = vi.fn(async () => (status === 200
    ? new Response(new ReadableStream({ pull: () => undefined, cancel: cancelled }), { status })
    : Response.json({ error: 'refused' }, { status })));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, cancelled };
}

const frame = (container: HTMLElement) => container.querySelector('iframe');
const sandboxTokens = (element: Element) => (element.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);

beforeEach(() => { targetMode.value = false; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('HP-05: Local loads the saved file by src in a frame sandboxed with allow-scripts only', async () => {
  const { fetchMock, cancelled } = stubCheck(200);
  const { container } = render(<HtmlPreview content={EDITOR_TEXT} source={SOURCE} />);
  await waitFor(() => expect(frame(container)?.getAttribute('src')).toBe(PREVIEW_URL));
  const iframe = frame(container)!;
  expect(sandboxTokens(iframe)).toEqual(['allow-scripts']);
  expect(iframe.hasAttribute('srcdoc')).toBe(false);
  // The check went through the API helper (with its request header) and dropped the body.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
  expect(url).toBe(PREVIEW_URL);
  expect(init.headers['X-RemoteCLI-Request']).toBe('1');
  await waitFor(() => expect(cancelled).toHaveBeenCalled());
  expect(screen.getByRole('note').textContent).toContain('isolated frame with no network');
});

it('HP-08: the notice says when the editor has unsaved changes, and a new key loads the frame again', async () => {
  const { fetchMock } = stubCheck(200);
  const { container, rerender } = render(<HtmlPreview content={EDITOR_TEXT} source={SOURCE} hasUnsavedChanges reloadKey={0} />);
  await waitFor(() => expect(frame(container)?.getAttribute('src')).toBe(PREVIEW_URL));
  expect(screen.getByRole('note').textContent).toContain('Showing the saved file. Save to see your unsaved changes.');
  const first = frame(container);
  rerender(<HtmlPreview content={EDITOR_TEXT} source={SOURCE} reloadKey={1} />);
  await waitFor(() => expect(frame(container)?.getAttribute('src')).toBe(PREVIEW_URL));
  expect(frame(container)).not.toBe(first);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('note').textContent).not.toContain('unsaved');
});

it('condition 6: when the page is not served, the frame never gets its src and only displays the HTML', async () => {
  for (const status of [401, 403, 404, 413, 500]) {
    stubCheck(status);
    const { container, unmount } = render(<HtmlPreview content={EDITOR_TEXT} source={SOURCE} />);
    await waitFor(() => expect(frame(container)?.hasAttribute('srcdoc')).toBe(true));
    const iframe = frame(container)!;
    expect(iframe.hasAttribute('src'), String(status)).toBe(false);
    expect(iframe.getAttribute('srcdoc')).toBe(EDITOR_TEXT);
    expect(sandboxTokens(iframe)).not.toContain('allow-same-origin');
    const note = screen.getByRole('note').textContent ?? '';
    expect(note).toContain('Scripts in the file do not run here.');
    expect(note.includes('larger than 10 MB'), String(status)).toBe(status === 413);
    unmount();
    vi.unstubAllGlobals();
  }
});

it('HP-06/HP-10e/HP-10f: a Remote tab never asks for the page and only displays the HTML', async () => {
  targetMode.value = true;
  const { fetchMock } = stubCheck(200);
  const { container } = render(<HtmlPreview content={EDITOR_TEXT} source={SOURCE} />);
  const iframe = frame(container)!;
  expect(iframe.getAttribute('srcdoc')).toBe(EDITOR_TEXT);
  expect(iframe.hasAttribute('src')).toBe(false);
  expect(sandboxTokens(iframe)).not.toContain('allow-same-origin');
  expect(screen.getByRole('note').textContent).toContain('Scripts in the file do not run in a Remote tab.');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  // And the tab's own request policy refuses the route.
  expect(isBlockedInTargetMode(PREVIEW_URL)).toBe(true);
  expect(isBlockedInTargetMode('/api/file-tree/projects/p1/files/HTML-PREVIEW/')).toBe(true);
  expect(isBlockedInTargetMode('/api/file-tree/projects/p1/files/content?path=a.html')).toBe(false);
});

it('HP-07: every registered locale translates the preview notices', () => {
  const locales = Object.keys(i18n.options.resources ?? {});
  expect(locales.length).toBeGreaterThanOrEqual(15);
  for (const locale of locales) {
    const strings = (i18n.getResourceBundle(locale, 'codeEditor') as { htmlPreview?: Record<string, unknown> })?.htmlPreview ?? {};
    for (const key of ['untrustedLocal', 'untrustedRemote', 'scriptsDisabled', 'unsavedChanges', 'tooLarge']) {
      expect(typeof strings[key] === 'string' && (strings[key] as string).trim().length > 0, `${locale} ${key}`).toBe(true);
    }
  }
});
