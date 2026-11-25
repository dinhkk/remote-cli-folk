import { useTranslation } from 'react-i18next';

import { useKillFlow } from '@/modules/agent-monitor/graph/KillFlowContext';

const KEY_OF = {
  killed: 'killed', stopped: 'stopped', gone: 'gone', 'no-handle': 'noHandle', unavailable: 'unavailable', refused: 'refused', error: 'error',
} as const;

/**
 * What the last kill came to, in a polite live region of the PANE: it outlives the box (a killed node leaves the graph) and
 * the graph's remounts. The region is always there so a screen reader hears the text arrive; empty while there is none.
 */
export function KillMessage() {
  const { t } = useTranslation('agentMonitor');
  const { enabled, message } = useKillFlow();
  if (!enabled) return null;
  const failed = message?.result === 'refused' || message?.result === 'error' || message?.result === 'unavailable';
  return (
    <div role="status" aria-live="polite" data-testid="kill-message" className={message ? `rounded-md border px-2 py-1 text-xs ${failed ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'border-border bg-card text-foreground'}` : 'sr-only'}>
      {message ? t(`graph.kill.result.${KEY_OF[message.result]}`, { count: message.count ?? 0 }) : ''}
    </div>
  );
}
