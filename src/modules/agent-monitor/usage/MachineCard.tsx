import { useTranslation } from 'react-i18next';

import { formatBytes, formatPercent } from '@/modules/agent-monitor/format/monitorFormat';
import type { AgentMonitorSnapshot } from '@/shared/types';

/** The machine using this much CPU, or this share of its memory, is flagged. */
export const CPU_WARNING_PERCENT = 85;
export const MEMORY_WARNING_PERCENT = 90;

const WARNING_CLASS = 'rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400';

/** A thin gauge under a reading; a missing reading (null) is an empty track. */
function Gauge({ percent, warn }: { percent: number | null; warn: boolean }) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div className={`h-full rounded-full ${warn ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * CPU and memory of the WHOLE MACHINE (the host running the server and every session), shown in the overview while no
 * session is selected. Nothing about a session or a process: those are shown for the node that is selected. CPU is a dash
 * until the server has two readings to compare; never zero.
 */
export function MachineCard({ snapshot, compact = false }: { snapshot: AgentMonitorSnapshot; compact?: boolean }) {
  const { t } = useTranslation('agentMonitor');
  const { cpuPercent, memoryUsedBytes, memoryTotalBytes } = snapshot.resources.machine;
  const memoryPercent = memoryTotalBytes > 0 ? (memoryUsedBytes / memoryTotalBytes) * 100 : null;
  const error = snapshot.resources.error;

  return (
    <section className={`h-full rounded-xl border border-border bg-card ${compact ? 'p-2' : 'p-3'}`} aria-labelledby="monitor-machine-title" data-testid="machine-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="monitor-machine-title" className="text-sm font-semibold text-foreground">{t('machine.title')}</h3>
        {(cpuPercent ?? 0) >= CPU_WARNING_PERCENT && <span className={WARNING_CLASS} data-testid="warning-cpu">{t('usage.warnCpu', { limit: CPU_WARNING_PERCENT })}</span>}
        {(memoryPercent ?? 0) >= MEMORY_WARNING_PERCENT && <span className={WARNING_CLASS} data-testid="warning-memory">{t('machine.warnMemory', { limit: MEMORY_WARNING_PERCENT })}</span>}
      </div>
      {error && <p className="mt-1 text-xs text-muted-foreground" data-testid="machine-state">{t('usage.sampleError', { message: error })}</p>}
      <div className={compact ? 'mt-1 space-y-1' : 'mt-2 space-y-2'}>
        <div>
          <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('usage.cpu')}</span>
            <span className="text-sm tabular-nums text-foreground" data-testid="machine-cpu">{formatPercent(cpuPercent)}</span>
          </div>
          <Gauge percent={cpuPercent} warn={(cpuPercent ?? 0) >= CPU_WARNING_PERCENT} />
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('usage.memory')}</span>
            <span className="text-sm tabular-nums text-foreground" data-testid="machine-memory">
              {memoryTotalBytes > 0 ? t('machine.memoryOf', { used: formatBytes(memoryUsedBytes), total: formatBytes(memoryTotalBytes) }) : '—'}
            </span>
          </div>
          <Gauge percent={memoryPercent} warn={(memoryPercent ?? 0) >= MEMORY_WARNING_PERCENT} />
        </div>
      </div>
    </section>
  );
}
