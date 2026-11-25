import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentProfilesPanel } from '@/modules/agent-profiles';
import SettingsSection from '@/modules/settings/SettingsSection';
import { isTargetMode } from '@/shared/transport/target-context';
import type { AgentSettingsProject, GenerateTargetProject } from '@/shared/types';

type AgentProfilesSettingsTabProps = {
  /** Claude sign-in state, shown in the first step of the setup guide. */
  claudeAuth: { authenticated: boolean; email: string | null; loading: boolean };
  /** Opens the Claude sign-in dialog. */
  onSignIn: () => void;
  /** The sidebar projects (`name` is the project id, `fullPath` its folder), the targets of Generate and the setup guide. */
  projects?: AgentSettingsProject[];
  /** Closes the settings dialog (when the setup guide ends, so the new chat shows). */
  onClose: () => void;
};

/**
 * The "Agent Profiles" tab of the settings dialog: manage agent templates and the agent files of a sidebar project
 * (hide/show, generate from templates). Separate from the "Agents" tab (provider login and permissions). The management API is
 * Host-only, so inside a Remote tab frame it explains that instead of rendering screens that would only fail.
 * Rendered by the settings module's Settings dialog.
 */
export default function AgentProfilesSettingsTab({ claudeAuth, onSignIn, projects = [], onClose }: AgentProfilesSettingsTabProps) {
  const { t } = useTranslation('agentProfiles');
  // Only projects with a folder can receive agent files.
  const targets = useMemo<GenerateTargetProject[]>(
    () => projects.flatMap((project) => {
      const directory = project.fullPath || project.path || '';
      return directory ? [{ projectId: project.name, name: project.displayName || project.name, directory }] : [];
    }),
    [projects],
  );

  if (isTargetMode()) {
    return <SettingsSection title={t('title')} description={t('remoteUnavailable')}><span /></SettingsSection>;
  }

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <AgentProfilesPanel claudeAuth={claudeAuth} onSignIn={onSignIn} projects={targets} onSetupFinished={onClose} />
    </SettingsSection>
  );
}
