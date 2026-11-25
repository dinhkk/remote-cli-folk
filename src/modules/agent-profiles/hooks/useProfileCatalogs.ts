import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { ProfileCatalogs } from '@/shared/types';

type Envelope<T> = { success?: boolean; data?: T };

/** Reads one catalog best-effort: a failed or refused request leaves that picker with only the values already chosen. */
async function readCatalog<T>(request: () => Promise<Response>, pick: (data: T) => string[]): Promise<string[]> {
  try {
    const response = await request();
    const body = (await response.json()) as Envelope<T>;
    return body.success && body.data ? [...new Set(pick(body.data))].filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Loads the lists the template and agent pickers choose from: the MCP servers configured in the app
 * (user scope), the Claude skills, and the Claude models. Tool names are a fixed list in
 * `CLAUDE_CODE_TOOL_NAMES`. Loaded once when the panel opens; no list is required for the forms to work.
 * Used by the agent-profiles panel, which passes the result to the template and agent forms.
 */
export function useProfileCatalogs(): ProfileCatalogs {
  // The picker options; start empty so the forms render at once and fill in when the lists arrive.
  const [catalogs, setCatalogs] = useState<ProfileCatalogs>({ mcpServers: [], skills: [], models: [] });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      readCatalog<{ servers?: { name?: string }[] }>(
        () => api.providers.mcpServers('claude', { scope: 'user' }),
        (data) => (data.servers ?? []).map((server) => String(server.name ?? '')),
      ),
      readCatalog<{ skills?: { name?: string }[] }>(
        () => api.providers.skills('claude'),
        (data) => (data.skills ?? []).map((skill) => String(skill.name ?? '')),
      ),
      readCatalog<{ models?: { OPTIONS?: { value: string }[] } }>(
        () => api.providers.models('claude'),
        (data) => (data.models?.OPTIONS ?? []).map((model) => model.value),
      ),
    ]).then(([mcpServers, skills, models]) => {
      if (!cancelled) setCatalogs({ mcpServers, skills, models });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return catalogs;
}
