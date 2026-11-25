import { useTranslation } from 'react-i18next';

import { formatTokenCount } from '@/modules/agent-monitor/format/monitorFormat';
import type { TokenShare } from '@/modules/agent-monitor/usage/agentTokenShares';

/** Horizontal bars of tokens, largest first. Empty reads as a dash, not a sentence. */
export function TokenBars({ title, shares, testId }: { title: string; shares: TokenShare[]; testId: string }) {
  const { t } = useTranslation('agentMonitor');
  const max = Math.max(1, ...shares.map((share) => share.tokens));
  return (
    <div className="min-w-0" data-testid={testId}>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      {shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('usage.noTokens')}</p>
      ) : (
        <ul className="space-y-1">
          {shares.map((share) => (
            <li key={share.key} className="text-xs">
              <div className="flex justify-between gap-2">
                <span className="min-w-0 truncate text-foreground">{share.label || '?'}</span>
                <span className="tabular-nums text-muted-foreground">{formatTokenCount(share.tokens)}</span>
              </div>
              <div className="h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary/70" style={{ width: `${Math.max(3, (share.tokens / max) * 100)}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
