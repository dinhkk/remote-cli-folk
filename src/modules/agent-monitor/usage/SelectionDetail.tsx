import { useTranslation } from 'react-i18next';

import { formatBytes, formatClock, formatPercent, formatTokenCount } from '@/modules/agent-monitor/format/monitorFormat';
import type { Selection } from '@/modules/agent-monitor/running/resolveSelection';
import { agentTokenShares } from '@/modules/agent-monitor/usage/agentTokenShares';
import { TokenBars } from '@/modules/agent-monitor/usage/TokenBars';
import type { AgentMonitorSession } from '@/shared/types';

type SelectionDetailProps = {
  selection: Selection;
  /** The server's clock now (ms), for the running timers. */
  now: number;
  /** When given (a sub-agent selected on a narrow pane), the card ends with a button that opens that agent's Activity. */
  onOpenActivity?: () => void;
};

const NONE = '—';
const isLive = (state: string) => state === 'running' || state === 'waiting';

function Row({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right tabular-nums text-foreground" data-testid={`detail-${id}`}>{value}</dd>
    </div>
  );
}

function SessionRows({ session, now }: { session: AgentMonitorSession; now: number }) {
  const { t } = useTranslation('agentMonitor');
  const { usage, orchestrator } = session;
  const context = orchestrator.contextTokens === null
    ? NONE
    : `${formatTokenCount(orchestrator.contextTokens)}${orchestrator.contextWindow ? ` / ${formatTokenCount(orchestrator.contextWindow)}` : ''}`;
  return (
    <>
      <Row id="state" label={t('detail.state')} value={t(`state.${session.state}`)} />
      <Row id="elapsed" label={t('detail.elapsed')} value={session.state !== 'idle' && session.runStartedAt ? formatClock(now - session.runStartedAt) : NONE} />
      {/* The whole process tree of the Claude process; not measured yet is a dash, never 0. */}
      <Row id="cpu" label={t('detail.cpu')} value={usage ? formatPercent(usage.cpuPercent) : NONE} />
      <Row id="memory" label={t('detail.memory')} value={usage ? formatBytes(usage.rssBytes) : NONE} />
      <Row id="processes" label={t('detail.processes')} value={usage ? String(usage.processCount) : NONE} />
      <Row id="context" label={t('detail.context')} value={context} />
      <Row id="cache" label={t('detail.cache')} value={session.cacheHitRatio === null ? NONE : formatPercent(session.cacheHitRatio * 100)} />
      <Row id="tokens" label={t('detail.tokens')} value={formatTokenCount(session.agentTokens)} />
    </>
  );
}

/**
 * The numbers of the one node the user selected: a session (or its main agent), an agent, or a group of child processes.
 * Only what is true of that node: an agent has no CPU or memory of its own (agents of a session share one process), so
 * those appear on the session and on process groups. Purely presentational; `resolveSelection` decides what is selected.
 */
export function SelectionDetail({ selection, now, onOpenActivity }: SelectionDetailProps) {
  const { t } = useTranslation('agentMonitor');
  const title = selection.kind === 'session'
    ? (selection.main ? selection.session.orchestrator.name : selection.session.label)
    : selection.kind === 'agent' ? selection.agent.name : (selection.group.name || t('graph.processOther'));

  return (
    <section className="rounded-lg border border-border bg-card p-3" aria-labelledby="monitor-detail-title" data-testid="selection-detail" data-detail-kind={selection.kind}>
      <h3 id="monitor-detail-title" className="mb-2 truncate text-sm font-semibold text-foreground" data-testid="detail-title">{title}</h3>
      <dl className="space-y-1">
        {selection.kind === 'session' && <SessionRows session={selection.session} now={now} />}
        {selection.kind === 'agent' && (() => {
          const { agent } = selection;
          const live = isLive(agent.state);
          return (
            <>
              <Row id="state" label={t('detail.state')} value={t(`state.${agent.state}`)} />
              <Row id="elapsed" label={t('detail.elapsed')} value={formatClock((live ? now : (agent.endedAt ?? now)) - agent.startedAt)} />
              <Row id="tokens" label={t('detail.tokens')} value={formatTokenCount(agent.tokens)} />
              <Row id="tools" label={t('detail.tools')} value={String(agent.toolCalls)} />
              <Row id="rate" label={t('detail.rate')} value={t('detail.perSecond', { value: formatTokenCount(Math.round(agent.tokensPerSecond)) })} />
              {agent.model && <Row id="model" label={t('detail.model')} value={agent.model} />}
              {live && agent.lastToolName && <Row id="tool" label={t('detail.tool')} value={agent.lastToolName} />}
              {agent.description && <Row id="description" label={t('detail.description')} value={agent.description} />}
            </>
          );
        })()}
        {selection.kind === 'process' && (
          <>
            <Row id="count" label={t('detail.count')} value={String(selection.group.count)} />
            <Row id="memory" label={t('detail.memory')} value={formatBytes(selection.group.rssBytes)} />
            <Row id="cpu" label={t('detail.cpu')} value={formatPercent(selection.group.cpuPercent)} />
          </>
        )}
      </dl>
      {selection.kind === 'agent' && onOpenActivity && (
        <button
          type="button"
          onClick={onOpenActivity}
          className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent"
          data-testid="detail-open-activity"
        >
          {t('agentActivity.open')}
        </button>
      )}
      {selection.kind === 'session' && <div className="mt-3"><TokenBars title={t('usage.byAgent')} shares={agentTokenShares(selection.session)} testId="tokens-by-agent" /></div>}
    </section>
  );
}
