import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatTokenCount } from '@/modules/agent-monitor/format/monitorFormat';
import { STATE_DOT, STATE_STYLE } from '@/modules/agent-monitor/graph/stateStyle';
import type { RunningChildRow, RunningSessionNode } from '@/modules/agent-monitor/running/buildRunningTree';
import { useRunningTree } from '@/modules/agent-monitor/running/RunningTreeScope';
import type { AgentMonitorState } from '@/shared/types';
import { cn } from '@/shared/utils';

/**
 * The rows the Running tab adds under a session: its main agent, and under that the sub-agents and the process groups
 * (siblings). Every row is a button: `aria-pressed` says whether it is the focused node, `aria-expanded` whether a row
 * with children is open. 44 px tall on a phone, denser from the `md` breakpoint where the sidebar is a mouse panel.
 */

export const ROW_BUTTON = 'flex min-h-[44px] min-w-0 flex-1 flex-col justify-center rounded-md px-2 py-1 text-left text-xs outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/60 md:min-h-[32px]';
const ROW_PRESSED = 'bg-primary/10 ring-1 ring-primary/40';

/** A round dot in the state's colour (the same hues as the graph). The state is also written next to it, so colour never carries it alone. */
export function StateDot({ state }: { state: AgentMonitorState | 'idle' }) {
  return <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', STATE_DOT[state])} />;
}

/** The chevron that opens or closes a row's children. */
export function ExpandToggle({ expanded, label, onToggle }: { expanded: boolean; label: string; onToggle: () => void }) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      onClick={onToggle}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 md:h-8 md:w-6"
    >
      <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** `12.3k tok`, with a `~` when the count was read from a transcript (a lower bound, not the SDK's own total). */
export function useTokenText(): (tokens: number, approximate: boolean) => string {
  const { t } = useTranslation('agentMonitor');
  return (tokens, approximate) => (approximate
    ? t('tree.tokensApprox', { tokens: formatTokenCount(tokens) })
    : t('tree.tokens', { tokens: formatTokenCount(tokens) }));
}

/** First line: the dot, the name and the state in words. Second line: whatever else is worth a glance (last tool, tokens, memory). */
function RowFace({ state, name, stateText, detail }: { state: AgentMonitorState | 'idle' | null; name: string; stateText: string | null; detail: string }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {state && <StateDot state={state} />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{name}</span>
        {stateText && state && <span className={cn('shrink-0 text-[11px]', state === 'idle' ? 'text-muted-foreground' : STATE_STYLE[state].text)}>{stateText}</span>}
      </span>
      {detail && <span className={cn('truncate text-[11px] text-muted-foreground', state && 'pl-4')}>{detail}</span>}
    </>
  );
}

function ChildRowButton({ node, row }: { node: RunningSessionNode; row: Exclude<RunningChildRow, { kind: 'folded' }> }) {
  const { t } = useTranslation('agentMonitor');
  const tokenText = useTokenText();
  const tree = useRunningTree();
  if (!tree) return null;
  const focused = tree.focus?.sessionKey === node.sessionKey && tree.focus.nodeKey === row.key;
  const select = () => tree.onToggleNode(node.sessionKey, row.key);

  if (row.kind === 'agent') {
    const { agent } = row;
    const detail = [
      agent.lastToolName ? `▸ ${agent.lastToolName}` : null,
      agent.tokens > 0 ? tokenText(agent.tokens, node.session.detail === 'transcript') : null,
    ].filter(Boolean).join(' · ');
    return (
      <li>
        <button
          type="button"
          aria-pressed={focused}
          aria-label={t('tree.focusAgent', { name: agent.name, state: t(`state.${agent.state}`) })}
          onClick={select}
          data-testid={`running-agent-${node.sessionKey}-${agent.id}`}
          data-state={agent.state}
          className={cn(ROW_BUTTON, 'w-full', focused && ROW_PRESSED)}
        >
          <RowFace state={agent.state} name={agent.name} stateText={t(`state.${agent.state}`)} detail={detail} />
        </button>
      </li>
    );
  }

  const name = row.group.name === '' ? t('graph.processOther') : row.group.name;
  const memory = formatBytes(row.group.rssBytes);
  return (
    <li>
      <button
        type="button"
        aria-pressed={focused}
        aria-label={t('tree.focusProcess', { name, count: row.group.count, memory })}
        onClick={select}
        data-testid={`running-process-${node.sessionKey}-${row.group.name === '' ? '*other' : row.group.name.toLowerCase()}`}
        className={cn(ROW_BUTTON, 'w-full', focused && ROW_PRESSED)}
      >
        {/* A process group has no state of its own, so it has no dot: only name, count and memory (never a command line). */}
        <RowFace state={null} name={`${name} ${t('graph.processCount', { count: row.group.count })}`} stateText={null} detail={memory} />
      </button>
    </li>
  );
}

/** The main agent of a session and, when it is open, its sub-agents and process groups. */
export function MainAgentBlock({ node }: { node: RunningSessionNode }) {
  const { t } = useTranslation('agentMonitor');
  const tree = useRunningTree();
  if (!tree) return null;

  const { orchestrator } = node.session;
  const focused = tree.focus?.sessionKey === node.sessionKey && tree.focus.nodeKey === node.mainKey;
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && tree.isExpanded(node.mainKey, node.mainExpandedByDefault);

  return (
    <li data-testid={`running-main-${node.sessionKey}`}>
      <div className="flex items-center">
        {hasChildren
          ? <ExpandToggle expanded={expanded} label={t(expanded ? 'tree.collapse' : 'tree.expand', { name: orchestrator.name })} onToggle={() => tree.toggleExpanded(node.mainKey, node.mainExpandedByDefault)} />
          : <span className="w-11 shrink-0 md:w-6" aria-hidden="true" />}
        <button
          type="button"
          aria-pressed={focused}
          aria-label={t('tree.focusMain', { name: orchestrator.name, session: node.session.label })}
          onClick={() => tree.onToggleNode(node.sessionKey, node.mainKey)}
          data-state={orchestrator.state}
          className={cn(ROW_BUTTON, focused && ROW_PRESSED)}
        >
          <RowFace state={orchestrator.state} name={orchestrator.name} stateText={t(`state.${orchestrator.state}`)} detail={orchestrator.lastToolName ? `▸ ${orchestrator.lastToolName}` : t('graph.mainAgent')} />
        </button>
      </div>
      {expanded && (
        <ul className="ml-4 border-l border-border pl-1" data-testid={`running-children-${node.sessionKey}`}>
          {node.children.map((row) => (row.kind === 'folded'
            ? <li key={row.key} className="px-2 py-1 pl-6 text-[11px] text-muted-foreground">{t('graph.finishedFolded', { count: row.count })}</li>
            : <ChildRowButton key={row.key} node={node} row={row} />))}
        </ul>
      )}
    </li>
  );
}

/**
 * Wraps one app session row of the sidebar's list. Outside the Running tab (or while the monitor has nothing for this
 * session) it returns the row untouched; in the Running tab it adds the chevron that opens the session and, below the row,
 * the main agent with its children. The row itself keeps all its own actions (rename, archive, fork, open).
 */
export function RunningSessionFrame({ sessionId, row }: { sessionId: string; row: ReactNode }) {
  const { t } = useTranslation('agentMonitor');
  const tree = useRunningTree();
  const node = tree?.tree.byAppSessionId.get(sessionId);
  if (!tree || !node) return <>{row}</>;

  const expanded = tree.isExpanded(node.nodeKey, node.sessionExpandedByDefault);
  return (
    <div data-testid={`running-session-${sessionId}`}>
      <div className="flex items-center">
        <ExpandToggle expanded={expanded} label={t(expanded ? 'tree.collapse' : 'tree.expand', { name: node.session.label })} onToggle={() => tree.toggleExpanded(node.nodeKey, node.sessionExpandedByDefault)} />
        <div className="min-w-0 flex-1">{row}</div>
      </div>
      {expanded && <ul className="ml-4 border-l border-border pl-1"><MainAgentBlock node={node} /></ul>}
    </div>
  );
}
