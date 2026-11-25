import { Loader2, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { useKillFlow, type KillView } from '@/modules/agent-monitor/graph/KillFlowContext';
import { killAction, type KillAction } from '@/modules/agent-monitor/graph/killability';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The words on the button for where it stands (none while idle: it is only an icon then). */
function wordsFor(view: KillView, action: KillAction, t: Translate): string {
  switch (view.step) {
    case 'armed':
      if (action.kind === 'process') return t('graph.kill.confirmProcesses', { count: action.count, name: action.name });
      return action.kind === 'main' ? t('graph.kill.confirmSession') : t('graph.kill.confirm');
    case 'pending': return t('graph.kill.pending');
    case 'waiting': return t('graph.kill.stopSent');
    case 'escalate': return view.escalation === 'session' ? t('graph.kill.killSession') : t('graph.kill.force');
    case 'escalateArmed': return t('graph.kill.forceConfirm');
    case 'killing': return t('graph.kill.killing');
    default: return '';
  }
}

/**
 * The kill button of a box: an icon at the corner of the focused box, and a short line next to it once it is pressed. It sits
 * BESIDE the box's own button (never inside it: a button in a button is invalid and a click would also select the box), and
 * keeps React Flow's drag and pan off it (`nodrag nopan`) and every pointer and key event to itself.
 */
export function KillButton({ node }: { node: GraphNode }) {
  const { t } = useTranslation('agentMonitor');
  const flow = useKillFlow();
  const action = killAction(node);
  if (!flow.enabled || !action) return null;

  const view = flow.view(node.id);
  const words = wordsFor(view, action, t as Translate);
  const busy = view.step === 'pending' || view.step === 'waiting' || view.step === 'killing';
  const armed = view.step === 'armed' || view.step === 'escalateArmed';
  const label = words || t('graph.kill.label', { name: action.name });
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <button
      type="button"
      className={`monitor-kill-button nodrag nopan absolute -top-3 right-1 z-10 flex min-h-6 max-w-[95%] items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-none shadow-sm ${armed ? 'border-red-500 bg-red-600 text-white' : 'border-border bg-card text-muted-foreground hover:text-red-600'} ${busy ? 'cursor-wait opacity-80' : ''}`}
      data-testid={`kill-${node.id}`}
      data-kill-step={view.step}
      aria-label={label}
      aria-busy={busy}
      disabled={busy}
      title={label}
      onClick={(event) => { stop(event); flow.press(node, action); }}
      onPointerDown={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onDoubleClick={stop}
    >
      {busy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" /> : <Power className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {words && <span className="truncate">{words}</span>}
    </button>
  );
}
