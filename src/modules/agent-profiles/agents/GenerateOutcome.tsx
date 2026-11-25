import { useTranslation } from 'react-i18next';

import type { GenerateAgentsResult, GeneratedAgentPlan } from '@/shared/types';

/** Text of one plan's status; `missing-values` names the empty required keys. */
function PlanStatus({ plan }: { plan: GeneratedAgentPlan }) {
  const { t } = useTranslation('agentProfiles');
  return <>{plan.status === 'missing-values'
    ? t('generate.status.missing-values', { keys: (plan.missing ?? []).join(', ') })
    : t(`generate.status.${plan.status}`)}</>;
}

/**
 * The preview table of the Generate form: one row per chosen template with the agent file it would write (name,
 * description for the orchestrator) and what would happen to it. Only `new` and `duplicate` rows write a file.
 * Used by the Generate form.
 */
export function GeneratePlanTable({ plans, agentsDirectory }: { plans: GeneratedAgentPlan[]; agentsDirectory: string }) {
  const { t } = useTranslation('agentProfiles');
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{t('generate.writesTo', { directory: agentsDirectory })}</p>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="py-1 pr-2">{t('generate.columns.name')}</th>
            <th className="py-1 pr-2">{t('generate.columns.description')}</th>
            <th className="py-1">{t('generate.columns.status')}</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) => (
            <tr key={plan.templateId} className="border-b border-border/50 align-top">
              <td className="py-1 pr-2 font-mono" title={plan.path}>{plan.name}</td>
              <td className="py-1 pr-2">{plan.description}</td>
              <td className={plan.status === 'new' || plan.status === 'duplicate' ? 'py-1' : 'py-1 text-amber-600'}><PlanStatus plan={plan} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What Apply did: the agent files created, regenerated and skipped (a skipped one says why) and whether they were put on
 * the repository's git exclude list. Used by the Generate form in place of the preview once Apply finished.
 */
export function GenerateResultView({ result }: { result: GenerateAgentsResult }) {
  const { t } = useTranslation('agentProfiles');
  const { gitExclude } = result;
  return (
    <div role="status" className="space-y-2 text-sm">
      <p>{t('generate.outcome', { created: result.created.length, regenerated: result.regenerated.length, skipped: result.skipped.length })}</p>
      <ul className="list-inside list-disc text-xs">
        {result.created.map((plan) => <li key={plan.templateId}>{t('generate.createdItem', { name: plan.name })}</li>)}
        {result.regenerated.map((plan) => <li key={plan.templateId}>{t('generate.regeneratedItem', { name: plan.name })}</li>)}
        {result.skipped.map((plan) => <li key={plan.templateId} className="text-amber-600"><span className="font-mono">{plan.name}</span>: <PlanStatus plan={plan} /></li>)}
      </ul>
      {result.scope === 'project' && (
        <p className="text-xs text-muted-foreground">
          {gitExclude.file
            ? t('generate.gitExcluded', { count: gitExclude.added.length, file: gitExclude.file })
            : t('generate.gitNotExcluded')}
        </p>
      )}
    </div>
  );
}
