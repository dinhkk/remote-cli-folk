import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { STATE_STYLE } from '@/modules/agent-monitor/graph/stateStyle';
import type { RunningSessionNode, RunningTerminalGroup } from '@/modules/agent-monitor/running/buildRunningTree';
import { ExpandToggle, MainAgentBlock, ROW_BUTTON, StateDot } from '@/modules/agent-monitor/running/RunningTreeRows';
import { useRunningTree } from '@/modules/agent-monitor/running/RunningTreeScope';
import { cn } from '@/shared/utils';

/**
 * Terminal sessions (Claude started outside the app) in the Running tab. They join the project row of the same folder, or
 * get a project row of their own, and carry a small "terminal" badge. Focusing one shows its graph, or its chat when the
 * app already knows the session; below it they have the same main agent / sub-agents / processes as an app session.
 */

function TerminalSessionBlock({ node }: { node: RunningSessionNode }) {
  const { t } = useTranslation('agentMonitor');
  const tree = useRunningTree();
  if (!tree) return null;

  const { session } = node;
  const focused = tree.focus?.sessionKey === node.sessionKey && tree.focus.nodeKey === null;
  const expanded = tree.isExpanded(node.nodeKey, node.sessionExpandedByDefault);
  const stateText = t(`state.${session.state}`);

  return (
    <li data-testid={`running-terminal-session-${node.sessionKey}`} data-state={session.state}>
      <div className="flex items-center">
        <ExpandToggle expanded={expanded} label={t(expanded ? 'tree.collapse' : 'tree.expand', { name: session.label })} onToggle={() => tree.toggleExpanded(node.nodeKey, node.sessionExpandedByDefault)} />
        <button
          type="button"
          aria-pressed={focused}
          aria-label={t('tree.focusSession', { name: session.label, state: stateText })}
          onClick={() => tree.onToggleSession(node)}
          className={cn(ROW_BUTTON, focused && 'bg-primary/10 ring-1 ring-primary/40')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <StateDot state={session.state} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{session.label}</span>
          </span>
          {/* Badge and state sit under the title, not beside it: in a narrow sidebar they would take the whole line and leave the title nothing but an ellipsis. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-4">
            <span
              data-testid="running-terminal-badge"
              className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t('tree.terminal')}
            </span>
            <span className={cn('text-[11px]', session.state === 'idle' ? 'text-muted-foreground' : STATE_STYLE[session.state].text)}>{stateText}</span>
          </span>
        </button>
      </div>
      {expanded && <ul className="ml-4 border-l border-border pl-1"><MainAgentBlock node={node} /></ul>}
    </li>
  );
}

/** The terminal sessions that share the folder of an app project the list draws: appended to that project's own sessions. */
export function RunningTerminalSessions({ projectId }: { projectId: string }) {
  const tree = useRunningTree();
  const nodes = tree?.tree.terminalByProjectId.get(projectId);
  if (!nodes || nodes.length === 0) return null;
  return <ul data-testid={`running-terminals-${projectId}`}>{nodes.map((node) => <TerminalSessionBlock key={node.sessionKey} node={node} />)}</ul>;
}

function TerminalProjectBlock({ group }: { group: RunningTerminalGroup }) {
  const { t } = useTranslation('agentMonitor');
  const tree = useRunningTree();
  if (!tree) return null;

  const key = `terminal-project:${group.key}`;
  const expanded = tree.isExpanded(key, true);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const name = group.name ?? t('graph.noProject');

  return (
    <div data-testid={`running-terminal-project-${group.key}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => tree.toggleExpanded(key, true)}
        title={group.path ?? undefined}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-lg bg-background px-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/60 md:min-h-[36px]"
      >
        <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{group.sessions.length}</span>
      </button>
      {expanded && <ul className="ml-3 border-l border-border pl-1.5 md:ml-3 md:pl-3">{group.sessions.map((node) => <TerminalSessionBlock key={node.sessionKey} node={node} />)}</ul>}
    </div>
  );
}

/** The project rows of terminal sessions whose folder is not a project of the list: after the app projects. */
export function RunningTerminalProjects() {
  const tree = useRunningTree();
  if (!tree || tree.tree.terminalGroups.length === 0) return null;
  return (
    <div className="space-y-1 pb-safe-area-inset-bottom md:space-y-1" data-testid="running-terminal-projects">
      {tree.tree.terminalGroups.map((group) => <TerminalProjectBlock key={group.key} group={group} />)}
    </div>
  );
}
