import { cn } from '@/shared/utils';

type ProfileSwitchProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
};

/** Used by the agent-profiles module's Agents list for the visible/hidden switch and by the template editor for the memory blocks switch; the settings module's own switch is private to it. */
export function ProfileSwitch({ checked, onChange, ariaLabel, disabled }: ProfileSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 flex-shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[18px] bg-white' : 'translate-x-[2px] bg-foreground/60',
        )}
      />
    </button>
  );
}
