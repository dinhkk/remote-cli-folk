import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { analyzeTemplatePlaceholders } from '@/shared/utils';
import type { AgentProfileParam } from '@/shared/types';

type TemplatePlaceholderCheckProps = {
  instructions: string;
  params: AgentProfileParam[];
  /** Adds an empty parameter with this key (the one-click fix for a missing key). */
  onAddParam: (key: string) => void;
};

/**
 * Compares `{{key}}` in the template instructions with the declared parameters (UI-T3, UI-T4): a key
 * without a parameter is a red error with a one-click "Add parameter" button (the editor blocks saving),
 * a parameter nobody uses is a yellow warning that does not block.
 * Used by the template editor of the agent-profiles module.
 */
export function TemplatePlaceholderCheck({ instructions, params, onAddParam }: TemplatePlaceholderCheckProps) {
  const { t } = useTranslation('agentProfiles');
  const { missing, unused } = analyzeTemplatePlaceholders(instructions, params.map((param) => param.key));
  if (missing.length === 0 && unused.length === 0) return null;

  return (
    <div className="space-y-1">
      {missing.map((key) => (
        <div key={key} role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{t('placeholders.missing', { key, placeholder: `{{${key}}}` })}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => onAddParam(key)}>
            {t('placeholders.addParam', { key })}
          </Button>
        </div>
      ))}
      {unused.map((key) => (
        <p key={key} role="status" className="text-xs text-amber-600">{t('placeholders.unused', { key })}</p>
      ))}
    </div>
  );
}
