import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ClaudeAgentListing } from '@/shared/types';

const NO_NAMES: string[] = [];

/** What one read of `GET /claude-agents` produced for one target folder: the listing or the failure. */
type Loaded = { key: string; listing: ClaudeAgentListing | null; error: unknown };

/**
 * Loads the agent list of one target: Claude's built-in agents, `~/.claude/agents` and, with a `directory` (a sidebar
 * project's absolute folder), that project's `.claude/agents`; null = the global list only. Reads again when the
 * target changes (the previous target's entries are never shown under the new one) or on `reload`, and offers
 * `changeHidden` and `changeManagers`, which edit the stored hide list or the list of agents allowed to use the `profiles`
 * tools (given the raw list, returns the new one), save it with the revision last seen (a stale revision rejects, see the
 * error notice), queue overlapping changes and reload. Both lists live in the same settings file and share one revision,
 * so either save moves it for both.
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
  // The two lists as the server stores them (raw, unknown names included) with the settings revision they share; every change is built from this.
  const stored = useRef<{ hidden: string[]; managers: string[]; rev: number }>({ hidden: [], managers: [], rev: 0 });
  // Tail of the queued saves, so two quick changes are sent one after the other.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    api.agentProfiles.claudeAgents(directory)
      .then((response) => readApiJson<ClaudeAgentListing>(response))
      .then(
        (listing) => {
          if (cancelled) return;
          // A listing read before a just-saved change can arrive late; never step back to an older revision.
          // An older Host may not send `managerNames`; that means none.
          const managerNames = listing.managerNames ?? [];
          if (listing.hiddenRev >= stored.current.rev) stored.current = { hidden: listing.hiddenNames, managers: managerNames, rev: listing.hiddenRev };
          setLoaded({ key, listing: { ...listing, managerNames }, error: null });
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

  const enqueue = useCallback((save: () => Promise<void>): Promise<void> => {
    const job = queueRef.current.then(async () => {
      await save();
      setReloadToken((token) => token + 1);
    });
    // A failed change must not block the ones queued after it; its caller still sees the rejection.
    queueRef.current = job.catch(() => undefined);
    return job;
  }, []);

  const changeHidden = useCallback((mutate: (names: string[]) => string[]): Promise<void> => enqueue(async () => {
    const current = stored.current;
    const saved = await readApiJson<{ hiddenClaudeAgents: string[]; rev: number }>(await api.agentProfiles.setHiddenClaudeAgents({
      names: mutate(current.hidden),
      rev: current.rev,
    }));
    // The next queued change starts from what the server just stored, not from the listing read earlier.
    stored.current = { ...current, hidden: saved.hiddenClaudeAgents, rev: saved.rev };
  }), [enqueue]);

  const changeManagers = useCallback((mutate: (names: string[]) => string[]): Promise<void> => enqueue(async () => {
    const current = stored.current;
    const saved = await readApiJson<{ profileManagerAgents: string[]; rev: number }>(await api.agentProfiles.setClaudeAgentManagers({
      names: mutate(current.managers),
      rev: current.rev,
    }));
    stored.current = { ...current, managers: saved.profileManagerAgents, rev: saved.rev };
  }), [enqueue]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // An answer that belongs to another target counts as "still loading" so the list never mixes two projects.
  const current = loaded && loaded.key === key ? loaded : null;
  const status: 'loading' | 'ready' | 'error' = !current ? 'loading' : current.listing ? 'ready' : 'error';

  return {
    entries: current?.listing?.items ?? [],
    builtinSource: current?.listing?.builtinSource ?? null,
    managerNames: current?.listing?.managerNames ?? NO_NAMES,
    status,
    error: current?.error ?? null,
    initiallyEmpty,
    changeHidden,
    changeManagers,
    reload,
  };
}
