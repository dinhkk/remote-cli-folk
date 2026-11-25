import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { AgentsTab } from '@/modules/agent-profiles/agents/AgentsTab';
import { GLOBAL_TARGET_ID, resolveGenerateTarget } from '@/modules/agent-profiles/agents/generate-target';
import { CorruptFilesNotice } from '@/modules/agent-profiles/common/CorruptFilesNotice';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { useAgentProfilesData } from '@/modules/agent-profiles/hooks/useAgentProfilesData';
import { useClaudeAgents } from '@/modules/agent-profiles/hooks/useClaudeAgents';
import { useProfileCatalogs } from '@/modules/agent-profiles/hooks/useProfileCatalogs';
import { useSetupGuideDismissed } from '@/modules/agent-profiles/hooks/useSetupGuideDismissed';
import { MemoryTab } from '@/modules/agent-profiles/memory/MemoryTab';
import { TemplatesTab } from '@/modules/agent-profiles/templates/TemplatesTab';
import { FirstRunWizard } from '@/modules/agent-profiles/wizard/FirstRunWizard';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { GenerateTargetProject } from '@/shared/types';

type PanelTab = 'agents' | 'templates' | 'memory';

const TABS: PanelTab[] = ['agents', 'templates', 'memory'];

type AgentProfilesPanelProps = {
  /** Claude sign-in state for the wizard's first step (from the settings dialog's provider status). */
  claudeAuth?: { authenticated: boolean; email: string | null; loading: boolean };
  /** Opens the Claude sign-in dialog from the wizard. */
  onSignIn?: () => void;
  /** The sidebar projects agent files can be generated for (id, name, absolute folder); none = only the global scope. */
  projects?: GenerateTargetProject[];
  /** Called when the setup guide ends with a project, after a chat on it was opened (the settings dialog closes so that chat shows). */
  onSetupFinished?: () => void;
};

const NO_PROJECTS: GenerateTargetProject[] = [];

/**
 * The Agent Profiles management screen: three tabs, Agents (the agent files of a sidebar project or of `~/.claude/agents`,
 * with hide/show and the Generate form), Templates (list and editor) and Memory (app-owned memory blocks). Owns what crosses tabs: the chosen target
 * (whose agent list is loaded here, so switching tabs does not reload it) and the shared load of the templates.
 * Also hosts the first-run guide: it opens by itself the first time the panel finds no agent files and the guide was not
 * dismissed, and from the "Setup guide" button afterwards. Used by the settings module's Agent Profiles tab (web only:
 * the server denies these routes to Remote).
 */
export function AgentProfilesPanel({ claudeAuth = { authenticated: false, email: null, loading: false }, onSignIn, projects = NO_PROJECTS, onSetupFinished }: AgentProfilesPanelProps) {
  const { t } = useTranslation('agentProfiles');
  const data = useAgentProfilesData();
  const catalogs = useProfileCatalogs();
  // The tab on screen.
  const [tab, setTab] = useState<PanelTab>('agents');
  // The chosen target of the Agents tab; null = not chosen yet (the first sidebar project, else the global scope).
  const [chosenTargetId, setChosenTargetId] = useState<string | null>(null);
  const targetId = chosenTargetId !== null && (chosenTargetId === GLOBAL_TARGET_ID || projects.some((project) => project.projectId === chosenTargetId))
    ? chosenTargetId
    : (projects[0]?.projectId ?? GLOBAL_TARGET_ID);
  const { project, target } = resolveGenerateTarget(projects, targetId);
  const claude = useClaudeAgents(target.directory);

  const { dismissed, dismiss } = useSetupGuideDismissed();
  // The guide: `auto` opens it by itself when the first agent list found no agent file and it was not dismissed before; `open` / `closed` are the user's explicit choices.
  const [guide, setGuide] = useState<'auto' | 'open' | 'closed'>('auto');
  const wizardOpen = guide === 'open' || (guide === 'auto' && claude.initiallyEmpty === true && !dismissed);

  const { openNewChat } = usePaletteOps();
  const finishSetup = (projectId: string | null) => {
    dismiss();
    setGuide('closed');
    if (!projectId) return;
    setChosenTargetId(projectId);
    openNewChat(projectId);
    onSetupFinished?.();
  };

  const loading = data.status === 'loading';
  // A failed load shows only the error notice with its retry: the lists would otherwise claim "nothing here yet".
  const failed = data.status === 'error';

  if (wizardOpen) {
    return (
      <FirstRunWizard
        templates={data.templates}
        projects={projects}
        claudeAuth={claudeAuth}
        onSignIn={onSignIn}
        onOpenTemplates={() => { setGuide('closed'); setTab('templates'); }}
        onApplied={claude.reload}
        onFinish={finishSetup}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setGuide('open')}>{t('wizard.open')}</Button>
      </div>
      <div role="tablist" aria-label={t('title')} className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>

      {failed && (
        <div className="space-y-2">
          <ProfileErrorNotice error={data.error} />
          <Button size="sm" variant="outline" onClick={() => void data.reload()}>{t('state.retry')}</Button>
        </div>
      )}
      <CorruptFilesNotice files={data.corrupt} />

      <div role="tabpanel">
        {tab === 'agents' && (
          <AgentsTab
            projects={projects}
            targetId={targetId}
            onTargetChange={setChosenTargetId}
            templates={data.templates}
            entries={claude.entries}
            status={claude.status}
            loadError={claude.error}
            builtinSource={claude.builtinSource}
            onChangeHidden={claude.changeHidden}
            onReload={claude.reload}
          />
        )}
        {/* A failed template load shows only the notice above: the list would otherwise claim "nothing here yet". */}
        {tab === 'templates' && !failed && (
          <TemplatesTab
            templates={data.templates}
            catalogs={catalogs}
            loading={loading}
            onReload={() => void data.reload()}
          />
        )}
        {/* Memory loads its own list; it borrows the Agents tab's agent list only for the read-only lock notice. */}
        {tab === 'memory' && (
          <MemoryTab
            projects={projects}
            agents={claude.entries}
            agentsReady={claude.status === 'ready'}
            agentsTarget={project?.name ?? t('agents.targetGlobal')}
          />
        )}
      </div>
    </div>
  );
}
