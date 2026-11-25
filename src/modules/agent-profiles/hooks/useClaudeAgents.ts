import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ClaudeAgentListing } from '@/shared/types';

/** What one read of `GET /claude-agents` produced for one target folder: the listing or the failure. */
type Loaded = { key: string; listing: ClaudeAgentListing | null; error: unknown };

/**
 * Loads the agent list of one target: Claude's built-in agents, `~/.claude/agents` and, with a `directory` (a sidebar
 * project's absolute folder), that project's `.claude/agents`; null = the global list only. Reads again when the
 * target changes (the previous target's entries are never shown under the new one) or on `reload`, and offers
 * `changeHidden`, which edits the stored hide list (given the raw list, returns the new one), saves it with the
 * revision last seen (a stale revision rejects, see the error notice), queues overlapping changes and reloads.
 * `initiallyEmpty` is fixed by the very first successful read: true when it found no agent file (only built-ins),
 * which is what makes the first-run guide open by itself. Used by the agent-profiles panel for the Agents tab.
 */
export function useClaudeAgents(directory: string | null) {
  const key = directory ?? '';
  // The newest finished read, tagged with the target it was for.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Whether the very first successful read found no agent file; null until then. Fixed afterwards, so the first-run guide is offered once, not whenever a list happens to be empty.
  const [initiallyEmpty, setInitiallyEmpty] = useState<boolean | null>(null);
  // Bumped after the hide list is saved, or on demand, so the listing is read again.
  const [reloadToken, setReloadToken] = useState(0);
  // The hide list as the server stores it (raw, unknown names included) with its revision; every change is built from this.
  const storedHidden = useRef<{ names: string[]; rev: number }>({ names: [], rev: 0 });
  // Tail of the queued hide-list saves, so two quick changes are sent one after the other.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    api.agentProfiles.claudeAgents(directory)
      .then((response) => readApiJson<ClaudeAgentListing>(response))
      .then(
        (listing) => {
          if (cancelled) return;
          // A listing read before a just-saved change can arrive late; never step back to an older revision.
          if (listing.hiddenRev >= storedHidden.current.rev) storedHidden.current = { names: listing.hiddenNames, rev: listing.hiddenRev };
          setLoaded({ key, listing, error: null });
          setInitiallyEmpty((first) => first ?? !listing.items.some((item) => item.source !== 'builtin'));
        },
        (failure) => {
          if (!cancelled) setLoaded({ key, listing: null, error: failure });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [directory, key, reloadToken]);

  const changeHidden = useCallback((mutate: (names: string[]) => string[]): Promise<void> => {
    const job = queueRef.current.then(async () => {
      const current = storedHidden.current;
      const saved = await readApiJson<{ hiddenClaudeAgents: string[]; rev: number }>(await api.agentProfiles.setHiddenClaudeAgents({
        names: mutate(current.names),
        rev: current.rev,
      }));
      // The next queued change starts from what the server just stored, not from the listing read earlier.
      storedHidden.current = { names: saved.hiddenClaudeAgents, rev: saved.rev };
      setReloadToken((token) => token + 1);
    });
    // A failed change must not block the ones queued after it; its caller still sees the rejection.
    queueRef.current = job.catch(() => undefined);
    return job;
  }, []);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // An answer that belongs to another target counts as "still loading" so the list never mixes two projects.
  const current = loaded && loaded.key === key ? loaded : null;
  const status: 'loading' | 'ready' | 'error' = !current ? 'loading' : current.listing ? 'ready' : 'error';

  return {
    entries: current?.listing?.items ?? [],
    builtinSource: current?.listing?.builtinSource ?? null,
    status,
    error: current?.error ?? null,
    initiallyEmpty,
    changeHidden,
    reload,
  };
}
