import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GeneratePlanTable, GenerateResultView } from '@/modules/agent-profiles/agents/GenerateOutcome';
import { GenerateParamFields } from '@/modules/agent-profiles/agents/GenerateParamFields';
import type { GenerateTarget } from '@/modules/agent-profiles/agents/generate-target';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { useRememberedValues } from '@/modules/agent-profiles/hooks/useRememberedValues';
import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type {
  AgentProfileParam,
  AgentProfileTemplate,
  AgentProfileValues,
  GenerateAgentsPreview,
  GenerateAgentsRequest,
  GenerateAgentsResult,
} from '@/shared/types';

type GenerateAgentsFormProps = {
  templates: AgentProfileTemplate[];
  target: GenerateTarget;
  /** Templates ticked when the form opens (the first-run guide passes the ones chosen in its second step). */
  initialTemplateIds?: string[];
  /** Hides the template checkboxes: the caller already chose them. */
  lockTemplates?: boolean;
  /** Called once Apply wrote files, so the caller can reload its agent list. */
  onApplied?: (result: GenerateAgentsResult) => void;
  /** Closes the form (Cancel, or the button shown after Apply). */
  onClose: () => void;
  /** Label of the button shown after Apply; "Done" when absent. */
  doneLabel?: string;
};

/** The distinct parameters of the chosen templates, one per key (the first definition names the field; required if any template requires it). */
function paramsOfTemplates(templates: AgentProfileTemplate[]): AgentProfileParam[] {
  const byKey = new Map<string, AgentProfileParam>();
  for (const template of templates) {
    for (const param of template.params) {
      const known = byKey.get(param.key);
      byKey.set(param.key, known ? { ...known, required: known.required || param.required, default: known.default || param.default } : param);
    }
  }
  return [...byKey.values()];
}

/**
 * The value typed for `key`, else the remembered one, else undefined. Own keys only: a parameter may be named `toString` or
 * `constructor`, which a plain `{}` lookup would answer with an inherited function.
 */
function typedOrRemembered(edits: AgentProfileValues, remembered: AgentProfileValues, key: string): string | undefined {
  // `Object.hasOwn` is not in this project's client lib target, hence the long form.
  const has = (map: AgentProfileValues): boolean => Object.prototype.hasOwnProperty.call(map, key);
  if (has(edits)) return edits[key];
  return has(remembered) ? remembered[key] : undefined;
}

/**
 * The Generate flow: tick templates, fill the parameters of those templates (pre-filled with what the server remembers
 * for the target folder; an empty field uses the template default), Preview to see per agent whether its file is new,
 * would be regenerated or is skipped (handmade file, missing value, invalid name), then Apply. The full set of values is
 * sent on every Preview and Apply, regenerate included, because the server does not merge remembered values. Remounted
 * (by `key`) when the target changes, which also re-reads the remembered values.
 * Used by the Agents tab and the first-run guide.
 */
export function GenerateAgentsForm({ templates, target, initialTemplateIds, lockTemplates = false, onApplied, onClose, doneLabel }: GenerateAgentsFormProps) {
  const { t } = useTranslation('agentProfiles');
  const { error, busy, run } = useProfileAction();
  const remembered = useRememberedValues(target.directory);
  // The templates ticked, in tick order.
  const [templateIds, setTemplateIds] = useState<string[]>(initialTemplateIds ?? []);
  // Values the user typed since opening; they win over the remembered ones. An empty string is kept: it makes the server forget the value.
  const [edits, setEdits] = useState<AgentProfileValues>({});
  // The preview of the current selection; reset by any change, so it never describes another selection.
  const [preview, setPreview] = useState<GenerateAgentsPreview | null>(null);
  // The outcome of the last Apply, shown instead of the form.
  const [result, setResult] = useState<GenerateAgentsResult | null>(null);

  const chosen = useMemo(() => templateIds.map((id) => templates.find((template) => template.id === id)).filter((template): template is AgentProfileTemplate => Boolean(template)), [templateIds, templates]);
  const params = useMemo(() => paramsOfTemplates(chosen), [chosen]);
  // What each field shows: typed text, else the remembered value.
  const shown = useMemo(() => Object.fromEntries(params.map((param) => [param.key, typedOrRemembered(edits, remembered.values, param.key) ?? ''])), [params, edits, remembered.values]);
  // The values to send: every key of the chosen templates that has typed or remembered text (an untouched empty field is left out, not sent as empty).
  const values = useMemo(() => Object.fromEntries(params.flatMap((param) => {
    const value = typedOrRemembered(edits, remembered.values, param.key);
    return value === undefined ? [] : [[param.key, value]];
  })), [params, edits, remembered.values]);

  const request = (): GenerateAgentsRequest => ({
    directory: target.directory,
    ...(target.directory ? { projectName: target.projectName } : {}),
    templateIds,
    values,
  });
  const toggleTemplate = (id: string) => {
    setTemplateIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
    setPreview(null);
  };
  const edit = (key: string, value: string) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setPreview(null);
  };
  const runPreview = async () => {
    const answer = await run(async () => readApiJson<GenerateAgentsPreview>(await api.agentProfiles.previewGenerate(request())));
    if (answer) setPreview(answer);
  };
  const apply = async () => {
    const answer = await run(async () => readApiJson<GenerateAgentsResult>(await api.agentProfiles.generate(request())));
    if (!answer) return;
    setResult(answer);
    onApplied?.(answer);
  };

  if (result) {
    return (
      <div className="space-y-3 rounded-md border border-border p-3">
        <GenerateResultView result={result} />
        <Button onClick={onClose}>{doneLabel ?? t('actions.done')}</Button>
      </div>
    );
  }

  const ready = remembered.status === 'ready';
  return (
    <div className="space-y-4 rounded-md border border-border p-3">
      <h4 className="text-base font-semibold">{t('generate.title')}</h4>
      <p className="text-xs text-muted-foreground">{target.directory ? t('generate.targetProject', { name: target.projectName }) : t('generate.targetGlobal')}</p>

      {!lockTemplates && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t('generate.templates')}</legend>
          {templates.length === 0 && <p className="text-xs text-muted-foreground">{t('generate.noTemplates')}</p>}
          {templates.map((template) => (
            <label key={template.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={templateIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} />
              {template.name}
              <span className="font-mono text-xs text-muted-foreground">{template.slug}</span>
            </label>
          ))}
        </fieldset>
      )}

      {remembered.status === 'loading' && <p className="text-sm text-muted-foreground">{t('state.loading')}</p>}
      {remembered.status === 'error' && (
        <div className="space-y-2">
          <ProfileErrorNotice error={remembered.error} />
          <p className="text-xs text-muted-foreground">{t('generate.valuesFailed')}</p>
          <Button size="sm" variant="outline" onClick={remembered.retry}>{t('state.retry')}</Button>
        </div>
      )}
      {ready && params.length > 0 && (
        <section className="space-y-3">
          <h5 className="text-sm font-semibold">{t('generate.valuesTitle')}</h5>
          <p className="text-xs text-muted-foreground">{t('generate.valuesHint')}</p>
          <GenerateParamFields params={params} values={shown} onChange={edit} />
        </section>
      )}

      {preview && <GeneratePlanTable plans={preview.plans} agentsDirectory={preview.agentsDirectory} />}

      <ProfileErrorNotice error={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !ready || templateIds.length === 0} onClick={() => void runPreview()}>{t('generate.preview')}</Button>
        {preview && (
          <Button disabled={busy || !preview.plans.some((plan) => plan.status === 'new' || plan.status === 'duplicate')} onClick={() => void apply()}>{t('generate.apply')}</Button>
        )}
        <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      </div>
    </div>
  );
}
