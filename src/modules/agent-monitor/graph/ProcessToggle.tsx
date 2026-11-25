import { Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ProcessToggleProps = {
  /** The child processes are drawn now. */
  shown: boolean;
  onToggle: () => void;
};

/**
 * The one switch for the child OS processes of every session (graph boxes and tree rows). An icon button: its name says
 * what a press does, `aria-pressed` says whether they are shown now. 44 px on a touch screen.
 */
export function ProcessToggle({ shown, onToggle }: ProcessToggleProps) {
  const { t } = useTranslation('agentMonitor');
  const label = t(shown ? 'graph.processes.hide' : 'graph.processes.show');
  return (
    <button
      type="button"
      aria-pressed={shown}
      aria-label={label}
      title={label}
      onClick={onToggle}
      data-testid="process-toggle"
      className={`flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${shown ? 'bg-accent text-foreground' : 'bg-transparent'}`}
    >
      <Cpu className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
