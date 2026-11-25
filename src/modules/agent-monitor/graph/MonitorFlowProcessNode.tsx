import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Boxes, Cpu, MemoryStick } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatPercent } from '@/modules/agent-monitor/format/monitorFormat';
import { NodeStat, NodeStatRow } from '@/modules/agent-monitor/graph/NodeStat';
import type { MonitorFlowNode } from '@/modules/agent-monitor/graph/buildFlowGraph';
import { FocusRing } from '@/modules/agent-monitor/graph/FocusRing';
import { KillButton } from '@/modules/agent-monitor/graph/KillButton';
import type { GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { useMonitorFlowEnv } from '@/modules/agent-monitor/graph/monitorFlowEnv';
import { PROCESS_STYLE } from '@/modules/agent-monitor/graph/stateStyle';

const RADIUS = 6;

/** A small chip with pins: the glyph of an OS process, so a process leaf never looks like an agent's state ring. */
function ChipGlyph() {
  return (
    <svg viewBox="-8 -8 16 16" width="16" height="16" className={`shrink-0 ${PROCESS_STYLE.stroke}`} aria-hidden="true">
      <rect x="-5" y="-5" width="10" height="10" rx="2" fill="none" strokeWidth="1.6" />
      <path d="M-2 -8 V-5 M2 -8 V-5 M-2 5 V8 M2 5 V8 M-8 -2 H-5 M-8 2 H-5 M5 -2 H8 M5 2 H8" fill="none" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A leaf for one group of child OS processes of a session (for example `node x3`): name, how many, their memory and CPU.
 * Smaller, dashed and grey so it reads as a different thing from an agent box. It is a button like the other boxes: it
 * focuses the group (a process cannot be attributed to one agent, so the graph shows the whole main agent's tree).
 * The group has no state of its own; it looks "settled" (dimmer) once its session is no longer working.
 */
export function MonitorFlowProcessNode({ data }: NodeProps<MonitorFlowNode>) {
  const { t } = useTranslation('agentMonitor');
  const { animate, highlightId, onSelect } = useMonitorFlowEnv();
  const node = data.graphNode as Extract<GraphNode, { kind: 'process' }>;
  const { group } = node;
  const focused = node.id === highlightId;
  const settled = node.state !== 'running';
  const title = group.name === '' ? t('graph.processOther') : group.name;
  const memory = formatBytes(group.rssBytes);
  const stats = [
    { icon: Boxes, value: String(group.count), label: t('graph.stat.processes', { value: group.count }) },
    { icon: MemoryStick, value: memory, label: t('graph.stat.memory', { value: memory }) },
    // CPU is left out until it is measured: "—" would only be noise on a small box.
    ...(group.cpuPercent === null ? [] : [{ icon: Cpu, value: formatPercent(group.cpuPercent), label: t('graph.stat.cpu', { value: formatPercent(group.cpuPercent) }) }]),
  ];
  const open = () => onSelect(node);

  return (
    <div className="relative h-full w-full">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div
        className="relative h-full w-full cursor-pointer outline-none focus-visible:[&>div:last-child]:ring-2 focus-visible:[&>div:last-child]:ring-primary"
        data-node-id={node.id}
        data-node-kind="process"
        data-node-state={node.state}
        data-node-focused={focused}
        role="button"
        tabIndex={0}
        aria-pressed={focused}
        aria-label={t('graph.processLabel', { name: title, count: group.count, memory })}
        title={[title, ...stats.map((entry) => entry.label)].join(' — ')}
        onClick={open}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }}
      >
        {focused && <FocusRing radius={RADIUS} />}
        <div
          className={`h-full w-full overflow-hidden border border-dashed ${PROCESS_STYLE.border} ${PROCESS_STYLE.box} ${settled ? 'opacity-70' : ''} ${animate ? 'monitor-enter' : ''}`}
          style={{ borderRadius: RADIUS }}
        >
          <div className="flex h-full min-w-0 flex-col justify-center gap-px px-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ChipGlyph />
              <span className={`min-w-0 truncate text-[11px] font-medium leading-tight text-foreground ${settled ? 'opacity-80' : ''}`}>{title}</span>
            </div>
            <NodeStatRow>{stats.map((entry) => <NodeStat key={entry.label} {...entry} />)}</NodeStatRow>
          </div>
        </div>
      </div>
      {/* Beside the box's own button, never inside it: the focused group can be killed from here. */}
      {focused && <KillButton node={node} />}
    </div>
  );
}
