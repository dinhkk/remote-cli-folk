import { useCallback } from 'react';

import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { api, readApiJson } from '@/shared/api';
import type { AgentBundleSnapshot, ExportBundleRequest, ExportBundleResult, ImportOptions, ImportPlan, ImportResult } from '@/shared/types';

/**
 * The bundle requests of the import, export and restore dialogs. One request runs at a time; each method resolves to the
 * server's answer, or to undefined when it failed (the failure is then in `error`, shown by `BundleErrorNotice`).
 * The methods keep their identity between renders, so an effect may depend on them.
 * Used by the three bundle dialogs of the agent-profiles module.
 */
export function useBundleActions() {
  const { error, busy, run, clearError } = useProfileAction();

  const exportBundle = useCallback(
    (request: ExportBundleRequest) => run(async () => readApiJson<ExportBundleResult>(await api.agentProfiles.exportBundle(request))),
    [run],
  );
  const preview = useCallback(
    (text: string, projectMap?: Record<string, string>) => run(async () => readApiJson<ImportPlan>(await api.agentProfiles.previewBundleImport(text, projectMap))),
    [run],
  );
  const apply = useCallback(
    (text: string, options: ImportOptions) => run(async () => readApiJson<ImportResult>(await api.agentProfiles.importBundle(text, options))),
    [run],
  );
  const listSnapshots = useCallback(
    () => run(async () => readApiJson<AgentBundleSnapshot[]>(await api.agentProfiles.listBundleSnapshots())),
    [run],
  );
  const restore = useCallback(
    (snapshot: string) => run(async () => readApiJson<ImportResult>(await api.agentProfiles.restoreBundleSnapshot(snapshot))),
    [run],
  );

  return { error, busy, clearError, exportBundle, preview, apply, listSnapshots, restore };
}
