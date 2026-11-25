import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSessionAgentScope } from '@/modules/agent-profiles/hooks/useSessionAgentScope';

type SessionScopeBadgeProps = {
  sessionId: string | null;
  /** False for providers without agent scopes: nothing is looked up. */
  enabled: boolean;
};

/**
 * Names the main agent an open session was started with. Read-only on purpose: the agent is fixed with the session, so
 * changing it means opening a new chat. A chat without a main agent shows nothing.
 * Used by chat's ChatInterface, above the composer of an open session.
 */
export function SessionScopeBadge({ sessionId, enabled }: SessionScopeBadgeProps) {
  const { t } = useTranslation('agentProfiles');
  const agentName = useSessionAgentScope(sessionId, enabled);
  if (!agentName) return null;

  return (
    <div className="mx-auto flex w-full max-w-[54.25rem] flex-wrap items-start gap-2 px-2 pb-1 sm:px-4">
      <span
        title={t('scope.badgeTitle')}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
      >
        <Bot className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="truncate">{t('scope.badge', { name: agentName })}</span>
      </span>
    </div>
  );
}
