import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BundleDialogFrame } from '@/modules/agent-profiles/bundle/BundleDialogFrame';
import { BundleErrorNotice } from '@/modules/agent-profiles/bundle/BundleErrorNotice';
import { BundleResultList } from '@/modules/agent-profiles/bundle/BundleResultList';
import { useBundleActions } from '@/modules/agent-profiles/bundle/useBundleActions';
import { Button } from '@/shared/ui';
import type { AgentBundleSnapshot, ImportResult } from '@/shared/types';

type RestoreSnapshotDialogProps = {
  onClose: () => void;
  /** Called after a restore succeeded, so the panel reloads its templates and blocks. */
  onApplied: () => void;
};

/**
 * The Restore dialog of the Agent Profiles panel: the backups the server took before imports overwrote something, newest
 * first, with a confirmation step before a restore and the per-item result afterwards. Restoring keeps items created
 * since and takes a fresh snapshot first. Used by the agent-profiles panel (Host only).
 */
export function RestoreSnapshotDialog({ onClose, onApplied }: RestoreSnapshotDialogProps) {
  const { t } = useTranslation('agentProfiles');
  const actions = useBundleActions();
  const { listSnapshots } = actions;
  // Null until the list is loaded.
  const [snapshots, setSnapshots] = useState<AgentBundleSnapshot[] | null>(null);
  // The snapshot waiting for the user's confirmation.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    let current = true;
    void listSnapshots().then((loaded) => { if (current && loaded) setSnapshots(loaded); });
    return () => { current = false; };
  }, [listSnapshots]);

  const newestFirst = useMemo(
    () => [...(snapshots ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [snapshots],
  );

  const restore = async (name: string) => {
    const outcome = await actions.restore(name);
    setConfirming(null);
    if (!outcome) return;
    setResult(outcome);
    onApplied();
    // The restore took a snapshot of its own: list again so it shows.
    const refreshed = await listSnapshots();
    if (refreshed) setSnapshots(refreshed);
  };

  return (
    <BundleDialogFrame title={t('bundle.restore.title')} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{t('bundle.restore.intro')}</p>
      <BundleErrorNotice error={actions.error} />
      {snapshots === null && !actions.error && <p className="text-sm text-muted-foreground">{t('bundle.loading')}</p>}
      {snapshots !== null && snapshots.length === 0 && <p className="text-sm text-muted-foreground">{t('bundle.restore.empty')}</p>}
      {newestFirst.length > 0 && (
        <ul className="space-y-2">
          {newestFirst.map((snapshot) => (
            <li key={snapshot.name} className="space-y-2 rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="break-all font-medium">{snapshot.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(snapshot.createdAt).toLocaleString()} · {t('bundle.restore.counts', { templates: snapshot.templates, blocks: snapshot.blocks, folders: snapshot.folders })} · {t('bundle.restore.size', { kb: Math.max(1, Math.round(snapshot.bytes / 1024)) })}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={t('bundle.restore.action', { name: snapshot.name })}
                  disabled={actions.busy}
                  onClick={() => setConfirming(snapshot.name)}
                >
                  {t('bundle.open.restore')}
                </Button>
              </div>
              {confirming === snapshot.name && (
                <div className="space-y-2 rounded-md bg-muted/50 p-2">
                  <p>{t('bundle.restore.confirm', { name: snapshot.name })}</p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={actions.busy} onClick={() => void restore(snapshot.name)}>
                      {actions.busy ? t('bundle.restore.running') : t('bundle.restore.confirmButton')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setConfirming(null)}>{t('bundle.cancel')}</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {result && <BundleResultList result={result} />}
    </BundleDialogFrame>
  );
}
