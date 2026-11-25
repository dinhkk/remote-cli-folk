import { useTranslation } from 'react-i18next';

import { ProfileField } from '@/modules/agent-profiles/common/ProfileField';
import { Input } from '@/shared/ui';
import { looksLikeRepositoryUrl } from '@/shared/utils';
import type { AgentProfileParam } from '@/shared/types';

type GenerateParamFieldsProps = {
  /** One entry per distinct parameter key of the chosen templates. */
  params: AgentProfileParam[];
  /** The text each field shows (typed or remembered); a key without an entry shows an empty field. */
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
};

/**
 * One input per parameter of the chosen templates: a text area for `text`, a single-line input for `dir`/`file`/`url`.
 * A field shows the remembered value for the target folder; an empty field falls back to the template default, which is
 * shown as its placeholder. A required parameter with neither a value nor a default is flagged on its own field.
 * Used by the Generate form.
 */
export function GenerateParamFields({ params, values, onChange }: GenerateParamFieldsProps) {
  const { t } = useTranslation('agentProfiles');

  return (
    <>
      {params.map((param) => {
        const value = values[param.key] ?? '';
        const id = `generate-param-${param.key}`;
        const missing = param.required && !value.trim() && !param.default?.trim();
        return (
          <ProfileField
            key={param.key}
            label={`${param.title || param.key}${param.required ? ' *' : ''}`}
            htmlFor={id}
            error={missing ? t('generate.requiredValue', { key: param.key }) : null}
            hint={param.description || undefined}
          >
            {param.type === 'text' ? (
              <textarea
                id={id}
                rows={2}
                value={value}
                placeholder={param.default ?? ''}
                onChange={(event) => onChange(param.key, event.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            ) : (
              // A plain text input: the browser's URL check would reject SSH addresses such as git@host:org/repo.
              <Input id={id} type="text" inputMode={param.type === 'url' ? 'url' : undefined} value={value} placeholder={param.default ?? ''} onChange={(event) => onChange(param.key, event.target.value)} />
            )}
            {param.type === 'url' && value.trim() && !looksLikeRepositoryUrl(value) && (
              <p role="status" className="text-xs text-amber-600">{t('generate.urlUnrecognized')}</p>
            )}
          </ProfileField>
        );
      })}
    </>
  );
}
