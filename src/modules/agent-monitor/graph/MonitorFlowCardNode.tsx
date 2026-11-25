import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Brain, Clock, Coins, Cpu, MemoryStick, Wrench, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatClock, formatPercent, formatTokenCount } from '@/modules/agent-monitor/format/monitorFormat';
import { NodeStat, NodeStatRow } from '@/modules/agent-monitor/graph/NodeStat';
import type { MonitorFlowNode } from '@/modules/agent-monitor/graph/buildFlowGraph';
import { FocusRing } from '@/modules/agent-monitor/graph/FocusRing';
import { KillButton } from '@/modules/agent-monitor/graph/KillButton';
import type { GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { useMonitorFlowEnv } from '@/modules/agent-monitor/graph/monitorFlowEnv';
import { StateGlyph } from '@/modules/agent-monitor/graph/StateGlyph';
import { STATE_STYLE } from '@/modules/agent-monitor/graph/stateStyle';

type CardGraphNode = Exclude<GraphNode, { kind: 'process' }>;

const RADIUS = 10;

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Stat = { icon: LucideIcon; value: string; label: string };

/** What a box says: a title, a row of icon + value chips, a last line (the tool it runs, else a role or description), a tooltip hint and the accessible name. */
function describe(node: CardGraphNode, now: number, t: Translate) {
  const stat = (key: string, icon: LucideIcon, value: string): Stat => ({ icon, value, label: t(`graph.stat.${key}`, { value }) });
  switch (node.kind) {
    case 'session': {
      const { session } = node;
      const stats: Stat[] = [];
      if (session.state !== 'idle' && session.runStartedAt) stats.push(stat('elapsed', Clock, formatClock(now - session.runStartedAt)));
      // The numbers of the whole process tree; not measured yet means no chip, and an unmeasured CPU reads "—", never 0.
      if (session.usage) stats.push(stat('cpu', Cpu, formatPercent(session.usage.cpuPercent)), stat('memory', MemoryStick, formatBytes(session.usage.rssBytes)));
      return {
        title: session.label,
        hint: `${session.projectName ?? t('graph.noProject')} · ${t(`state.${session.state}`)}`,
        stats,
        toolLine: '',
        ariaLabel: t('graph.selectSession', { name: session.label }),
      };
    }
    case 'orchestrator': {
      const { orchestrator, runStartedAt } = node.session;
      const working = node.state === 'running' || node.state === 'waiting';
      const stats: Stat[] = [];
      if (working && runStartedAt) stats.push(stat('elapsed', Clock, formatClock(now - runStartedAt)));
      if (orchestrator.contextTokens !== null) stats.push(stat('context', Brain, formatTokenCount(orchestrator.contextTokens)));
      return {
        title: orchestrator.name,
        hint: t(`state.${node.state}`),
        stats,
        toolLine: orchestrator.lastToolName ? `▸ ${orchestrator.lastToolName}` : t(orchestrator.fromProfile ? 'graph.orchestrator' : 'graph.mainAgent'),
        ariaLabel: t('graph.selectMain', { name: orchestrator.name }),
      };
    }
    case 'agent': {
      const { agent } = node;
      const live = agent.state === 'running' || agent.state === 'waiting';
      const elapsed = formatClock((live ? now : (agent.endedAt ?? now)) - agent.startedAt);
      return {
        title: agent.name,
        hint: '',
        stats: [stat('elapsed', Clock, elapsed), stat('tokens', Coins, formatTokenCount(agent.tokens)), stat('tools', Wrench, String(agent.toolCalls))],
        toolLine: live && agent.lastToolName ? `▸ ${agent.lastToolName}` : (agent.description || t(`state.${agent.state}`)),
        ariaLabel: t('graph.selectAgent', { name: agent.name, state: t(`state.${agent.state}`) }),
      };
    }
    default: {
      const title = t('graph.finishedFolded', { count: node.count });
      return { title, hint: '', stats: [] as Stat[], toolLine: '', ariaLabel: title };
    }
  }
}

/**
 * The box of a session, a main agent (orchestrator), a sub-agent or the "+N finished" fold, with its connectors: the
 * incoming one at the left, the outgoing one at the right (the session has no incoming, an agent no outgoing, the fold none
 * at all: see `buildFlowGraph.ts`, which declares the same dots). All but the
 * fold are buttons: focusable, Enter/Space or a click selects, and a focused one carries the ring and reads as pressed.
 * React Flow positions and drags this component; the connectors are drawn dots, never draggable.
 */
export function MonitorFlowCardNode({ data }: NodeProps<MonitorFlowNode>) {
  const { t } = useTranslation('agentMonitor');
  const { now, animate, highlightId, onSelect } = useMonitorFlowEnv();
  const node = data.graphNode as CardGraphNode;
  const style = STATE_STYLE[node.state];
  const folded = node.kind === 'folded';
  const focused = node.id === highlightId;
  // A finished box recedes (dimmer) so the eye stays on what is still working.
  const settled = node.state === 'done' || node.state === 'stopped';
  const { title, hint, stats, toolLine, ariaLabel } = describe(node, now, t as Translate);
  const open = () => onSelect(node);
  const tooltip = [title, hint, ...stats.map((entry) => entry.label), toolLine].filter(Boolean).join(' — ');

  const surface = (
    <div
      className={`relative h-full w-full overflow-hidden border-[1.75px] bg-card ${style.border} ${folded ? 'border-dashed' : ''} ${settled ? 'opacity-70' : ''} ${animate ? 'monitor-enter' : ''} ${animate && node.state === 'failed' ? 'monitor-shake' : ''} ${animate && node.state === 'done' ? 'monitor-done' : ''}`}
      style={{ borderRadius: RADIUS }}
    >
      {animate && node.state === 'running' && !folded && <span aria-hidden="true" className={`monitor-pulse pointer-events-none absolute inset-0 border-2 ${style.border}`} style={{ borderRadius: RADIUS }} />}
      <div className="flex h-full min-w-0 flex-col justify-center gap-px px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {!folded && <StateGlyph state={node.state} animate={animate} />}
          <span className={`min-w-0 truncate text-[11px] font-semibold leading-tight text-foreground ${settled ? 'opacity-80' : ''}`}>{title}</span>
        </div>
        {stats.length > 0 && <NodeStatRow>{stats.map((entry) => <NodeStat key={entry.label} {...entry} />)}</NodeStatRow>}
        {toolLine && <span className={`truncate text-[10px] leading-tight ${toolLine.startsWith('▸') ? STATE_STYLE.running.text : 'text-muted-foreground'}`}>{toolLine}</span>}
      </div>
    </div>
  );

  return (
    <div className="relative h-full w-full">
      {(node.kind === 'orchestrator' || node.kind === 'agent') && <Handle type="target" position={Position.Left} isConnectable={false} />}
      {folded ? (
        <div
          className="h-full w-full"
          data-node-id={node.id}
          data-node-kind={node.kind}
          data-node-state={node.state}
          role="img"
          aria-label={ariaLabel}
          title={tooltip}
        >
          {surface}
        </div>
      ) : (
        <div
          className="relative h-full w-full cursor-pointer outline-none focus-visible:[&>div:last-child]:ring-2 focus-visible:[&>div:last-child]:ring-primary"
          data-node-id={node.id}
          data-node-kind={node.kind}
          data-node-state={node.state}
          data-node-focused={focused}
          role="button"
          tabIndex={0}
          aria-pressed={focused}
          aria-label={ariaLabel}
          title={tooltip}
          onClick={open}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }}
        >
          {focused && <FocusRing radius={RADIUS} />}
          {surface}
        </div>
      )}
      {/* Beside the box's own button, never inside it: the focused main agent or sub-agent can be stopped or killed from here. */}
      {focused && <KillButton node={node} />}
      {(node.kind === 'session' || node.kind === 'orchestrator') && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}
