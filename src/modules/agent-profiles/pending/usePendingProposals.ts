import { useCallback, useEffect, useRef, useState } from 'react';

import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { notifyPendingChanged } from '@/modules/agent-profiles/pending/pending-events';
import { useVisiblePolling } from '@/modules/agent-profiles/pending/useVisiblePolling';
import { api, readApiJson } from '@/shared/api';
import type { ImportResult, PendingConfirmRequest, PendingProposalView } from '@/shared/types';

/** How often the list is read while the tab is on screen and the page is visible. */
const LIST_POLL_MS = 15_000;

/** What a confirmed proposal did, kept on screen after the proposal itself left the list. */
export type PendingOutcome = { id: string; agentName: string; result: ImportResult };

/**
 * The waiting proposals for the Pending tab: read when the tab opens, on `refresh` and every 15 s while the page is visible
 * (polling reads silently, without the loading state). `confirm` sends the user's choices and keeps the per-item result in
 * `outcomes` (the proposal leaves the list); `reject` drops a proposal. Both tell the pending counts on screen to read again,
 * and a failure is in `error` (shown by `ProfileErrorNotice`). An expired proposal is gone from the next read.
 * Used by the Pending tab of the agent-profiles panel.
 */
export function usePendingProposals() {
  const [proposals, setProposals] = useState<PendingProposalView[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<unknown>(null);
  // The time of the newest read, which the cards measure age and expiry against (reading the clock while rendering is not pure).
  const [now, setNow] = useState(() => Date.now());
  const [outcomes, setOutcomes] = useState<PendingOutcome[]>([]);
  const action = useProfileAction();
  // Only the newest read may set the list, so a slow older answer cannot bring back a proposal that was just removed.
  const latest = useRef(0);

  // `silent`: a background read keeps what is on screen when it fails. The state only changes once an answer arrives.
  const fetchList = useCallback((silent: boolean) => {
    const request = ++latest.current;
    api.agentProfiles.listPending()
      .then((response) => readApiJson<PendingProposalView[]>(response))
      .then(
        (list) => {
          if (request !== latest.current) return;
          setProposals(list);
          setNow(Date.now());
          setLoadError(null);
          setStatus('ready');
        },
        (failure) => {
          // A failed background read keeps what is on screen; only an explicit read shows the failure.
          if (request !== latest.current || silent) return;
          setLoadError(failure);
          setStatus('error');
        },
      );
  }, []);

  useEffect(() => {
    fetchList(false);
    return () => {
      // Answers still on the way belong to an unmounted tab.
      latest.current += 1;
    };
  }, [fetchList]);

  useVisiblePolling(useCallback(() => fetchList(true), [fetchList]), LIST_POLL_MS);

  const refresh = useCallback(() => {
    setStatus('loading');
    fetchList(false);
  }, [fetchList]);

  const { run } = action;
  const confirm = useCallback(async (proposal: PendingProposalView, request: PendingConfirmRequest): Promise<boolean> => {
    const result = await run(async () => readApiJson<ImportResult>(await api.agentProfiles.confirmPending(proposal.id, request)));
    // A failed confirm may mean the proposal is gone (expired or confirmed elsewhere): read the truth either way.
    fetchList(true);
    notifyPendingChanged();
    if (!result) return false;
    setOutcomes((current) => [...current, { id: proposal.id, agentName: proposal.agentName, result }]);
    return true;
  }, [run, fetchList]);

  const reject = useCallback(async (proposal: PendingProposalView): Promise<boolean> => {
    const done = await run(async () => readApiJson<{ rejected: true }>(await api.agentProfiles.rejectPending(proposal.id)));
    fetchList(true);
    notifyPendingChanged();
    return done !== undefined;
  }, [run, fetchList]);

  const dismissOutcome = useCallback((id: string) => setOutcomes((current) => current.filter((outcome) => outcome.id !== id)), []);

  return { proposals, now, status, loadError, outcomes, error: action.error, busy: action.busy, refresh, confirm, reject, dismissOutcome };
}
