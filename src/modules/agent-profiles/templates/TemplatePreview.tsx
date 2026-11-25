import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { extractPlaceholderKeys, renderTemplateInstructions } from '@/shared/utils';
import type { AgentProfileParam } from '@/shared/types';

type TemplatePreviewProps = {
  instructions: string;
  params: AgentProfileParam[];
};

/**
 * Preview of the template editor (UI-T8): type sample values for the keys the instructions use and read the
 * prompt exactly as an agent would receive it (same escaping and `<param>` wrapping the server applies).
 * Used by the template editor of the agent-profiles module.
 */
export function TemplatePreview({ instructions, params }: TemplatePreviewProps) {
  const { t } = useTranslation('agentProfiles');
  // Sample values typed by the user, by key; needed because a preview has no project or agent to take values from.
  const [sample, setSample] = useState<Record<string, string>>({});
  const keys = extractPlaceholderKeys(instructions);
  // Only keys that can be filled (declared parameters and the reserved project keys) get a value, like on the server;
  // a key with no parameter stays as written, which is what the missing-key error is about.
  const declared = new Set([...params.map((param) => param.key), 'project_name', 'project_directory']);
  const values = Object.fromEntries(
    keys.filter((key) => declared.has(key)).map((key) => [key, sample[key] ?? params.find((param) => param.key === key)?.default ?? '']),
  );

  return (
    <div className="space-y-2">
      {keys.filter((key) => declared.has(key)).map((key) => (
        <div key={key} className="flex items-center gap-2">
          <span className="w-32 flex-shrink-0 truncate font-mono text-xs">{key}</span>
          <Input
            aria-label={t('preview.sampleValue', { key })}
            value={sample[key] ?? params.find((param) => param.key === key)?.default ?? ''}
            onChange={(event) => setSample((current) => ({ ...current, [key]: event.target.value }))}
          />
        </div>
      ))}
      <pre aria-label={t('preview.rendered')} className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs">
        {renderTemplateInstructions(instructions, values)}
      </pre>
    </div>
  );
}
