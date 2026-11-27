import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BundleResultList } from '@/modules/agent-profiles/bundle/BundleResultList';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { PendingProposalCard } from '@/modules/agent-profiles/pending/PendingProposalCard';
import { usePendingProposals } from '@/modules/agent-profiles/pending/usePendingProposals';
import { Button } from '@/shared/ui';

type PendingTabProps = {
  /** Called after a confirm changed templates or memory blocks, so the panel's other tabs read them again. */
  onApplied?: () => void;
};

/**
 * The Pending tab: what manager agents proposed and nobody confirmed yet, each as a readable review with Confirm and Reject,
 * and below the result of every proposal just confirmed (per item, with the partial warning and the backup name). Reads when
 * it opens, on the refresh button and every 15 s while the page is visible. Rendered by the agent-profiles panel (Host only).
 */
export function PendingTab({ onApplied }: PendingTabProps) {
  const { t } = useTranslation('agentProfiles');
  const pending = usePendingProposals();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('pending.intro')}</p>
        <Button type="button" size="sm" variant="outline" disabled={pending.status === 'loading'} onClick={pending.refresh}>
          <RefreshCw /> {t('pending.refresh')}
        </Button>
      </div>

      {pending.status === 'loading' && pending.proposals.length === 0 && <p className="text-sm text-muted-foreground">{t('state.loading')}</p>}
      {pending.status === 'error' && <ProfileErrorNotice error={pending.loadError} />}
      <ProfileErrorNotice error={pending.error} onReload={pending.refresh} />

      {pending.outcomes.map((outcome) => (
        <div key={outcome.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-medium">{t('pending.outcomeTitle', { agent: outcome.agentName })}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => pending.dismissOutcome(outcome.id)}>{t('pending.dismiss')}</Button>
          </div>
          <BundleResultList result={outcome.result} />
        </div>
      ))}

      {pending.status === 'ready' && pending.proposals.length === 0 && pending.outcomes.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('pending.empty')}</p>
      )}
      {pending.proposals.map((proposal) => (
        <PendingProposalCard
          key={proposal.id}
          proposal={proposal}
          now={pending.now}
          busy={pending.busy}
          onConfirm={(request) => void pending.confirm(proposal, request).then((applied) => { if (applied) onApplied?.(); })}
          onReject={() => void pending.reject(proposal)}
        />
      ))}
    </div>
  );
}
