import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, htmlPreviewPath } from '@/shared/api';
import { isTargetMode } from '@/shared/transport/target-context';

/** The saved file the Local preview loads from the server. */
export type HtmlPreviewSource = { projectId: string; filePath: string };

type HtmlPreviewProps = {
  /** The editor's text: shown, without running its scripts, when the isolated page cannot be used. */
  content: string;
  title?: string;
  /** Without a source (or in a Remote tab) the preview only displays the HTML. */
  source?: HtmlPreviewSource | null;
  /** The editor holds changes the saved file does not have yet. */
  hasUnsavedChanges?: boolean;
  /** Changes after every save, so the isolated frame loads the file again. */
  reloadKey?: number;
};

type Mode = 'checking' | 'isolated' | 'display';

/**
 * Inline preview for HTML files inside CodeEditor.
 *
 * Local: the frame loads the saved file from the server's preview page with `sandbox="allow-scripts"`. The
 * server sends that page with a sandbox policy and no network source, so the file's scripts run in an opaque
 * origin: no session, no access to this app, no request to anything.
 *
 * Remote tab, or when that page is not available (platform mode, a server error): the HTML is displayed from
 * the editor text; the app's page policy keeps its scripts from running. The frame never gets
 * `allow-same-origin`.
 */
export const HtmlPreview = memo(({ content, title = 'HTML Preview', source = null, hasUnsavedChanges = false, reloadKey = 0 }: HtmlPreviewProps) => {
  const { t } = useTranslation('codeEditor');
  const remote = isTargetMode();
  const projectId = source?.projectId;
  const filePath = source?.filePath;
  const canIsolate = !remote && Boolean(projectId && filePath);
  // The answer of the last check, for the file and save it was made for.
  const checkKey = `${projectId ?? ''}\n${filePath ?? ''}\n${reloadKey}`;
  const [checked, setChecked] = useState<{ key: string; status: number } | null>(null);
  const status = checked?.key === checkKey ? checked.status : null;
  const mode: Mode = !canIsolate ? 'display' : status === null ? 'checking' : status === 200 ? 'isolated' : 'display';
  const tooLarge = canIsolate && status === 413;

  useEffect(() => {
    if (!canIsolate || !projectId || !filePath) return undefined;
    const controller = new AbortController();
    // The frame itself cannot report an error page: ask first, and use the isolated page only when it is
    // served. Only the status is needed, so the body is dropped as soon as it arrives.
    api.checkHtmlPreview(projectId, filePath, { signal: controller.signal })
      .then((response) => {
        void response.body?.cancel().catch(() => undefined);
        if (!controller.signal.aborted) setChecked({ key: checkKey, status: response.status });
      })
      .catch(() => {
        if (!controller.signal.aborted) setChecked({ key: checkKey, status: 0 });
      });
    return () => controller.abort();
  }, [canIsolate, projectId, filePath, checkKey]);

  const notice = mode === 'isolated'
    ? t('htmlPreview.untrustedLocal', "Untrusted content. The file's scripts run in an isolated frame with no network and no access to this app. Files it links to (CDN, other project files) do not load.")
    : remote
      ? t('htmlPreview.untrustedRemote', 'Untrusted content. Scripts in the file do not run in a Remote tab.')
      : t('htmlPreview.scriptsDisabled', 'Untrusted content. Scripts in the file do not run here.');

  return (
    <div className="flex h-full w-full flex-col bg-white dark:bg-zinc-950">
      <div role="note" className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
        <p>{notice}</p>
        {mode === 'display' && tooLarge && (
          <p>{t('htmlPreview.tooLarge', 'The file is larger than 10 MB, so its scripts do not run.')}</p>
        )}
        {mode === 'isolated' && hasUnsavedChanges && (
          <p className="font-medium">{t('htmlPreview.unsavedChanges', 'Showing the saved file. Save to see your unsaved changes.')}</p>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'isolated' && projectId && filePath && (
          <iframe
            key={reloadKey}
            title={title}
            sandbox="allow-scripts"
            src={htmlPreviewPath(projectId, filePath)}
            className="h-full w-full border-0 bg-white"
          />
        )}
        {mode === 'display' && (
          <iframe
            title={title}
            sandbox="allow-scripts allow-forms allow-modals"
            srcDoc={content}
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
});

HtmlPreview.displayName = 'HtmlPreview';
export default HtmlPreview;
