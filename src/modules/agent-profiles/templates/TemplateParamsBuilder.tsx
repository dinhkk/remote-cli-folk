import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import { findParamKeyProblem } from '@/shared/utils';
import type { AgentProfileParam, AgentProfileParamType } from '@/shared/types';

type TemplateParamsBuilderProps = {
  params: AgentProfileParam[];
  onChange: (next: AgentProfileParam[]) => void;
};

const PARAM_TYPES: AgentProfileParamType[] = ['text', 'dir', 'file', 'url'];

/**
 * The schema builder of the template editor (UI-T2): add, edit, remove and reorder the parameters of a
 * template (key, type, title, description, required, default). A key that is invalid, reserved or used
 * twice is flagged on its row; the editor blocks saving while any row is flagged.
 * Used by the template editor of the agent-profiles module.
 */
export function TemplateParamsBuilder({ params, onChange }: TemplateParamsBuilderProps) {
  const { t } = useTranslation('agentProfiles');
  const keys = params.map((param) => param.key);
  const update = (index: number, patch: Partial<AgentProfileParam>) =>
    onChange(params.map((param, current) => (current === index ? { ...param, ...patch } : param)));
  const move = (index: number, offset: number) => {
    const next = [...params];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {params.length === 0 && <p className="text-xs text-muted-foreground">{t('params.empty')}</p>}
      {params.map((param, index) => {
        const problem = findParamKeyProblem(keys, index);
        return (
          <div key={index} role="group" aria-label={t('params.row', { index: index + 1 })} className="space-y-2 rounded-md border border-border p-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_1fr]">
              <Input aria-label={t('params.key')} placeholder={t('params.key')} value={param.key} onChange={(event) => update(index, { key: event.target.value })} />
              <select
                aria-label={t('params.type')}
                value={param.type}
                onChange={(event) => update(index, { type: event.target.value as AgentProfileParamType })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {PARAM_TYPES.map((type) => <option key={type} value={type}>{t(`params.types.${type}`)}</option>)}
              </select>
              <Input aria-label={t('params.title')} placeholder={t('params.title')} value={param.title} onChange={(event) => update(index, { title: event.target.value })} />
            </div>
            {problem && <p role="alert" className="text-xs text-destructive">{t(`params.keyProblem.${problem}`)}</p>}
            <Input aria-label={t('params.description')} placeholder={t('params.description')} value={param.description} onChange={(event) => update(index, { description: event.target.value })} />
            <div className="flex flex-wrap items-center gap-3">
              <Input aria-label={t('params.default')} placeholder={t('params.default')} className="min-w-0 flex-1" value={param.default ?? ''} onChange={(event) => update(index, { default: event.target.value })} />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={param.required} onChange={(event) => update(index, { required: event.target.checked })} />
                {t('params.required')}
              </label>
              <Button type="button" size="sm" variant="ghost" aria-label={t('params.moveUp')} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
              <Button type="button" size="sm" variant="ghost" aria-label={t('params.moveDown')} disabled={index === params.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
              <Button type="button" size="sm" variant="ghost" aria-label={t('params.remove')} onClick={() => onChange(params.filter((_, current) => current !== index))}><Trash2 /></Button>
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...params, { key: '', type: 'text', title: '', description: '', required: false }])}
      >
        <Plus /> {t('params.add')}
      </Button>
    </div>
  );
}
