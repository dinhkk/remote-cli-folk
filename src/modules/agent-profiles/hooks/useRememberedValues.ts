import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { AgentProfileValues, GenerateRememberedValues } from '@/shared/types';

/** One finished read of `GET /generate/values` for a folder: the remembered values or the failure. */
type Loaded = { key: string; values: AgentProfileValues; error: unknown };

/**
 * Reads the values the server remembers for a target folder (null = the global scope) so the Generate form can
 * pre-fill its fields. Reads again when the target changes (values of the previous target are never shown under the
 * new one) or on `retry`. `status` is `loading` until the answer for the current target arrived, `error` when it
 * could not be read: the form then refuses to preview or apply, because sending values without what was remembered
 * would regenerate files with the template defaults.
 * Used by the Generate form of the Agents tab and the first-run guide.
 */
export function useRememberedValues(directory: string | null) {
  const key = directory ?? '';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Bumped by `retry` to read the same target again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.agentProfiles.generateValues(directory)
      .then((response) => readApiJson<GenerateRememberedValues>(response))
      .then(
        (answer) => { if (!cancelled) setLoaded({ key, values: answer.values ?? {}, error: null }); },
        (failure) => { if (!cancelled) setLoaded({ key, values: {}, error: failure }); },
      );
    return () => {
      cancelled = true;
    };
  }, [directory, key, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  const current = loaded && loaded.key === key ? loaded : null;
  const status: 'loading' | 'ready' | 'error' = !current ? 'loading' : current.error ? 'error' : 'ready';
  return { values: current?.values ?? {}, status, error: current?.error ?? null, retry };
}
