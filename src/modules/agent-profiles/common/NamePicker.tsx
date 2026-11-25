import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type NamePickerProps = {
  label: string;
  /** Every name the user may pick (real tools, configured MCP servers, skills); nothing outside it can be typed. */
  options: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
};

/**
 * Used by the template editor to choose tool, MCP server or skill names: chips for
 * the chosen ones and a list of the rest, so names are picked from real lists instead of typed.
 * A chosen name that is no longer offered (e.g. a server that was removed) stays as a chip until removed.
 */
export function NamePicker({ label, options, selected, onChange }: NamePickerProps) {
  const { t } = useTranslation('agentProfiles');
  const remaining = options.filter((option) => !selected.includes(option));

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="flex flex-wrap items-center gap-1">
        {selected.map((name) => (
          <span key={name} className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs">
            {name}
            <button
              type="button"
              aria-label={t('picker.remove', { name })}
              onClick={() => onChange(selected.filter((entry) => entry !== name))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <select
          aria-label={t('picker.add', { label })}
          value=""
          disabled={remaining.length === 0}
          onChange={(event) => event.target.value && onChange([...selected, event.target.value])}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">{remaining.length === 0 ? t('picker.nothingToAdd') : t('picker.addPlaceholder')}</option>
          {remaining.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
    </div>
  );
}
