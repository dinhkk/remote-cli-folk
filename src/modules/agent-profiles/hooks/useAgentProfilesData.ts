import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { AgentProfileCorruptEntry, AgentProfileList, AgentProfileTemplate } from '@/shared/types';

type TemplatesSnapshot = { templates: AgentProfileTemplate[]; corrupt: AgentProfileCorruptEntry[] };

const EMPTY: TemplatesSnapshot = { templates: [], corrupt: [] };

/** Reads the template collection: the readable templates plus the stored files that were skipped. */
async function fetchTemplates(): Promise<TemplatesSnapshot> {
  const list = await readApiJson<AgentProfileList<AgentProfileTemplate>>(await api.agentProfiles.listTemplates());
  return { templates: list.items, corrupt: list.corrupt ?? [] };
}

/**
 * Loads the templates and reloads them on demand after a change. `status` drives the loading/error states of the
 * Templates tab and the Generate form (the agent list itself comes from `useClaudeAgents`, per project).
 * Used by the agent-profiles panel, which hands the result to its tabs.
 */
export function useAgentProfilesData() {
  // The last successfully loaded templates; kept while a reload runs so lists do not flash empty.
  const [snapshot, setSnapshot] = useState<TemplatesSnapshot>(EMPTY);
  // Where the load stands; lists render their loading and error states from it.
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // The failure of the last load, shown with a retry button.
  const [error, setError] = useState<unknown>(null);
  // Only the newest request may write state; an older answer arriving late is dropped.
  const requestRef = useRef(0);

  const reload = useCallback(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    return fetchTemplates().then(
      (loaded) => {
        if (requestRef.current !== request) return;
        setSnapshot(loaded);
        setError(null);
        setStatus('ready');
      },
      (failure) => {
        if (requestRef.current !== request) return;
        setError(failure);
        setStatus('error');
      },
    );
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...snapshot, status, error, reload };
}
