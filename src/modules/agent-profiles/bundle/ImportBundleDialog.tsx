import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { BundleDialogFrame } from '@/modules/agent-profiles/bundle/BundleDialogFrame';
import { BundleErrorNotice } from '@/modules/agent-profiles/bundle/BundleErrorNotice';
import { BundleResultList } from '@/modules/agent-profiles/bundle/BundleResultList';
import { ImportPlanTable } from '@/modules/agent-profiles/bundle/ImportPlanTable';
import {
  MAX_BUNDLE_BYTES,
  SKIP_FOLDER,
  buildImportOptions,
  byteLength,
  isBundleTooLarge,
  megabytes,
  sourceFolders,
} from '@/modules/agent-profiles/bundle/bundle-helpers';
import { useBundleActions } from '@/modules/agent-profiles/bundle/useBundleActions';
import { Button } from '@/shared/ui';
import type { GenerateTargetProject, ImportPlan, ImportResult } from '@/shared/types';

type ImportBundleDialogProps = {
  /** The sidebar projects a source folder can be mapped to (their ids are what the server takes). */
  projects: GenerateTargetProject[];
  onClose: () => void;
  /** Called after an apply succeeded, so the panel reloads its templates and blocks. */
  onApplied: () => void;
};

const toggled = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

const readFileText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(reader.error ?? new Error('read failed'));
  reader.readAsText(file);
});

/**
 * The Import dialog of the Agent Profiles panel: a file or pasted text, a client size check, a preview table with the
 * user's ticks (overwrite per conflict, allow per sensitive item, nothing ticked by default), a folder-to-project
 * mapping shown only when the bundle carries folder text (changing it previews again), Apply with the preview's basis
 * of every ticked row, and the per-item result. Used by the agent-profiles panel (Host only).
 */
export function ImportBundleDialog({ projects, onClose, onApplied }: ImportBundleDialogProps) {
  const { t } = useTranslation('agentProfiles');
  const actions = useBundleActions();
  // The bundle text: typed, pasted or read from a file.
  const [text, setText] = useState('');
  // Size in bytes of a chosen file that was refused without reading it; null otherwise.
  const [refusedBytes, setRefusedBytes] = useState<number | null>(null);
  const [fileFailed, setFileFailed] = useState(false);
  // The latest preview of `text`; cleared whenever the text changes so the table never describes other text.
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [overwrite, setOverwrite] = useState<ReadonlySet<string>>(new Set());
  const [acceptSensitive, setAcceptSensitive] = useState<ReadonlySet<string>>(new Set());
  // Source folder key -> sidebar project id; SKIP_FOLDER (or absent) leaves the folder out.
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // What the last apply did; Apply stays disabled until the next preview.
  const [result, setResult] = useState<ImportResult | null>(null);

  const tooLarge = refusedBytes !== null || isBundleTooLarge(text);
  const sizeMb = megabytes(refusedBytes ?? byteLength(text));
  const folders = useMemo(() => (plan ? sourceFolders(plan) : []), [plan]);
  const needsFolderNote = plan?.items.some((item) => item.kind === 'block' && item.scope === 'project' && item.status !== 'invalid' && !item.folders?.length) ?? false;

  // The text the table on screen was previewed from; a preview that returns for older text is dropped.
  const currentText = useRef(text);

  const changeText = (next: string) => {
    currentText.current = next;
    setText(next);
    setRefusedBytes(null);
    setFileFailed(false);
    setPlan(null);
    setResult(null);
    actions.clearError();
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) {
      changeText('');
      setRefusedBytes(file.size);
      return;
    }
    try {
      changeText(await readFileText(file));
    } catch {
      changeText('');
      setFileFailed(true);
    }
  };

  const runPreview = async (map: Record<string, string>, keepTicks: boolean) => {
    const chosen = Object.fromEntries(Object.entries(map).filter(([, projectId]) => projectId !== SKIP_FOLDER));
    const next = await actions.preview(text, Object.keys(chosen).length > 0 ? chosen : undefined);
    if (!next || currentText.current !== text) return;
    const keys = new Set(next.items.flatMap((item) => [item.key, ...(item.folders ?? []).map((folder) => folder.key)]));
    setPlan(next);
    setResult(null);
    setOverwrite(keepTicks ? new Set([...overwrite].filter((key) => keys.has(key))) : new Set());
    setAcceptSensitive(keepTicks ? new Set([...acceptSensitive].filter((key) => keys.has(key))) : new Set());
  };

  const changeMapping = (sourceKey: string, projectId: string) => {
    const next = { ...mapping, [sourceKey]: projectId };
    setMapping(next);
    void runPreview(next, true);
  };

  const apply = async () => {
    if (!plan) return;
    const outcome = await actions.apply(text, buildImportOptions(plan, { overwrite, acceptSensitive, projectMap: mapping }));
    if (!outcome) return;
    setResult(outcome);
    onApplied();
  };

  const sensitiveKeys = plan?.items.filter((item) => item.sensitive.length > 0).map((item) => item.key) ?? [];

  return (
    <BundleDialogFrame title={t('bundle.import.title')} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{t('bundle.privacyWarning')}</p>

      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="bundle-import-file">{t('bundle.import.chooseFile')}</label>
        <input id="bundle-import-file" type="file" accept=".yaml,.yml,.json,text/*" onChange={(event) => void chooseFile(event)} className="block w-full text-sm" />
        <label className="block text-sm font-medium" htmlFor="bundle-import-text">{t('bundle.import.pasteLabel')}</label>
        <textarea
          id="bundle-import-text"
          rows={8}
          value={text}
          placeholder={t('bundle.import.pastePlaceholder')}
          onChange={(event) => changeText(event.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
        />
      </div>
      {tooLarge && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{t('bundle.import.tooLarge', { size: sizeMb })}</div>}
      {fileFailed && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{t('bundle.import.readFailed')}</div>}
      <BundleErrorNotice error={actions.error} />

      <div className="flex flex-wrap gap-2">
        {result === null ? (
          <Button type="button" size="sm" disabled={actions.busy || tooLarge || text.trim() === ''} onClick={() => void runPreview(mapping, true)}>
            {actions.busy && !plan ? t('bundle.import.previewing') : t('bundle.import.preview')}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={actions.busy} onClick={() => void runPreview(mapping, false)}>{t('bundle.import.previewAgain')}</Button>
        )}
        {plan && (
          <Button type="button" size="sm" disabled={actions.busy || result !== null || plan.items.length === 0} onClick={() => void apply()}>
            {actions.busy && result === null && plan ? t('bundle.import.applying') : t('bundle.import.apply')}
          </Button>
        )}
      </div>

      {plan && plan.items.length === 0 && <p className="text-sm text-muted-foreground">{t('bundle.import.nothingToImport')}</p>}

      {plan && plan.hasFolderText && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('bundle.import.mapping.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('bundle.import.mapping.hint')}</p>
          {folders.map((folder) => (
            <div key={folder.sourceKey} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{folder.sourceDirectory}</span>
              <select
                aria-label={t('bundle.import.mapping.select', { directory: folder.sourceDirectory })}
                value={mapping[folder.sourceKey] ?? SKIP_FOLDER}
                disabled={actions.busy || result !== null}
                onChange={(event) => changeMapping(folder.sourceKey, event.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                <option value={SKIP_FOLDER}>{t('bundle.import.mapping.skip')}</option>
                {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
            </div>
          ))}
        </section>
      )}

      {plan && plan.items.length > 0 && (
        <ImportPlanTable
          plan={plan}
          overwrite={overwrite}
          acceptSensitive={acceptSensitive}
          onToggleOverwrite={(key) => setOverwrite((current) => toggled(current, key))}
          onToggleSensitive={(key) => setAcceptSensitive((current) => toggled(current, key))}
          onSelectAllSensitive={() => setAcceptSensitive(new Set(sensitiveKeys))}
          locked={result !== null}
        />
      )}
      {needsFolderNote && <p className="text-sm text-muted-foreground">{t('bundle.import.noFolderNote')}</p>}

      {result && <BundleResultList result={result} />}
    </BundleDialogFrame>
  );
}
