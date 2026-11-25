import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GenerateAgentsForm } from '@/modules/agent-profiles/agents/GenerateAgentsForm';
import { Badge, Button } from '@/shared/ui';
import type { AgentProfileTemplate, GenerateTargetProject } from '@/shared/types';

type FirstRunWizardProps = {
  templates: AgentProfileTemplate[];
  /** The sidebar projects agents can be generated for. */
  projects: GenerateTargetProject[];
  /** Claude sign-in state from the settings dialog's provider status; `loading` while it is still being read. */
  claudeAuth: { authenticated: boolean; email: string | null; loading: boolean };
  /** Opens the Claude sign-in dialog; absent where signing in is not offered. */
  onSignIn?: () => void;
  /** Leaves the guide for the Templates tab, where a template can be created (shown when there is none to choose). */
  onOpenTemplates: () => void;
  /** Called after agent files were generated so the panel reads its agent list again. */
  onApplied: () => void;
  /** Called when the guide ends: with the id of the sidebar project it generated agents for (the caller opens a chat on it), or null when it was skipped before that. */
  onFinish: (projectId: string | null) => void;
};

type WizardStep = 1 | 2 | 3;

/**
 * The first-run guide: three steps, each skippable and the whole guide too. (1) check that Claude is signed in, (2) choose
 * which templates to use, (3) choose a sidebar project, fill the values the templates need and generate their agent files
 * into the project's `.claude/agents`. Ends by handing the project to the caller, which opens a new chat on it.
 * Used by the Agent Profiles panel, on first visit with nothing set up and from its "Setup guide" button.
 */
export function FirstRunWizard({ templates, projects, claudeAuth, onSignIn, onOpenTemplates, onApplied, onFinish }: FirstRunWizardProps) {
  const { t } = useTranslation('agentProfiles');
  // The step on screen.
  const [step, setStep] = useState<WizardStep>(1);
  // Templates the user unticked; every template counts as picked otherwise.
  const [unpickedIds, setUnpickedIds] = useState<string[]>([]);
  const pickedIds = templates.filter((template) => !unpickedIds.includes(template.id)).map((template) => template.id);
  // The sidebar project chosen in step 3 ('' = the first one).
  const [chosenProjectId, setChosenProjectId] = useState('');
  // The project agents were generated for; set once Apply wrote files, which ends the project choice.
  const [appliedProjectId, setAppliedProjectId] = useState<string | null>(null);

  const project = projects.find((candidate) => candidate.projectId === chosenProjectId) ?? projects[0] ?? null;
  const toggle = (id: string) => setUnpickedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <section aria-label={t('wizard.title')} className="space-y-4 rounded-lg border border-border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{t('wizard.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('wizard.stepOf', { step, total: 3 })}</p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => onFinish(appliedProjectId)}>{t('wizard.skipSetup')}</Button>
      </header>

      {step === 1 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t('wizard.step1.title')}</h4>
          {claudeAuth.loading ? (
            <p role="status" className="text-sm text-muted-foreground">{t('state.loading')}</p>
          ) : claudeAuth.authenticated ? (
            <p role="status" className="text-sm">{claudeAuth.email ? t('wizard.step1.signedInAs', { email: claudeAuth.email }) : t('wizard.step1.signedIn')}</p>
          ) : (
            <div className="space-y-2">
              <p role="status" className="text-sm text-amber-600">{t('wizard.step1.signedOut')}</p>
              {onSignIn && <Button type="button" variant="outline" size="sm" onClick={onSignIn}>{t('wizard.step1.signIn')}</Button>}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={() => setStep(2)}>{t('wizard.next')}</Button>
            <Button type="button" variant="ghost" onClick={() => setStep(2)}>{t('wizard.skipStep')}</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t('wizard.step2.title')}</h4>
          <p className="text-xs text-muted-foreground">{t('wizard.step2.hint')}</p>
          {templates.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm">{t('wizard.step2.none')}</p>
              <Button type="button" variant="outline" size="sm" onClick={onOpenTemplates}>{t('wizard.step2.openTemplates')}</Button>
            </div>
          ) : (
            <fieldset className="space-y-1">
              <legend className="sr-only">{t('wizard.step2.title')}</legend>
              {templates.map((template) => (
                <label key={template.id} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={pickedIds.includes(template.id)} onChange={() => toggle(template.id)} />
                  <span>
                    <span className="font-medium">{template.name}</span> <Badge variant="secondary">{t(`family.${template.family}`)}</Badge>{' '}
                    <span className="text-xs text-muted-foreground">{template.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex gap-2">
            <Button type="button" disabled={pickedIds.length === 0} onClick={() => setStep(3)}>{t('wizard.next')}</Button>
            <Button type="button" variant="ghost" onClick={() => setStep(1)}>{t('wizard.back')}</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t('wizard.step3.title')}</h4>
          {project === null ? (
            <div className="space-y-2">
              <p className="text-sm">{t('wizard.step3.noProjects')}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep(2)}>{t('wizard.back')}</Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('wizard.step3.hint')}</p>
              {appliedProjectId === null && (
                <label className="flex items-center gap-2 text-sm">
                  {t('wizard.step3.project')}
                  <select
                    value={project.projectId}
                    onChange={(event) => setChosenProjectId(event.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {projects.map((candidate) => <option key={candidate.projectId} value={candidate.projectId}>{candidate.name}</option>)}
                  </select>
                </label>
              )}
              <GenerateAgentsForm
                key={project.projectId}
                templates={templates}
                target={{ directory: project.directory, projectName: project.name }}
                initialTemplateIds={pickedIds}
                lockTemplates
                onApplied={() => { setAppliedProjectId(project.projectId); onApplied(); }}
                onClose={() => onFinish(appliedProjectId)}
                doneLabel={t('wizard.step3.openChat', { name: project.name })}
              />
              {appliedProjectId === null && <Button type="button" variant="ghost" size="sm" onClick={() => setStep(2)}>{t('wizard.back')}</Button>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
