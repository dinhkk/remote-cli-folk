import { useTranslation } from 'react-i18next';

import { NamePicker } from '@/modules/agent-profiles/common/NamePicker';
import { ProfileField } from '@/modules/agent-profiles/common/ProfileField';
import { AGENT_DELEGATION_TOOL_NAMES, CLAUDE_CODE_TOOL_NAMES } from '@/shared/constants';
import type { AgentProfileCapabilities, ProfileCatalogs } from '@/shared/types';

type CapabilityFieldsProps = {
  value: AgentProfileCapabilities;
  onChange: (next: AgentProfileCapabilities) => void;
  catalogs: ProfileCatalogs;
  /** Whether the skills picker is shown. */
  showSkills?: boolean;
  /** An orchestrator must be able to call the delegation tool; warn when the chosen tools take that away. */
  isOrchestrator?: boolean;
};

/**
 * Used by the template editor to pick allowed tools, denied tools,
 * MCP servers, skills and the model from real lists. For an orchestrator it warns when the
 * allow/deny choice leaves it without the delegation tool.
 */
export function CapabilityFields({ value, onChange, catalogs, showSkills = false, isOrchestrator = false }: CapabilityFieldsProps) {
  const { t } = useTranslation('agentProfiles');
  const set = (patch: Partial<AgentProfileCapabilities>) => onChange({ ...value, ...patch });
  const lacksDelegation = isOrchestrator && (
    (value.tools.length > 0 && !value.tools.some((tool) => AGENT_DELEGATION_TOOL_NAMES.includes(tool)))
    || value.disallowedTools.some((tool) => AGENT_DELEGATION_TOOL_NAMES.includes(tool))
  );
  // A model that is chosen but not in the catalog (older template, offline list) must stay selectable.
  const models = value.model && !catalogs.models.includes(value.model) ? [value.model, ...catalogs.models] : catalogs.models;

  return (
    <div className="space-y-3">
      <NamePicker label={t('capabilities.tools')} options={CLAUDE_CODE_TOOL_NAMES} selected={value.tools} onChange={(tools) => set({ tools })} />
      <NamePicker label={t('capabilities.disallowedTools')} options={CLAUDE_CODE_TOOL_NAMES} selected={value.disallowedTools} onChange={(disallowedTools) => set({ disallowedTools })} />
      {lacksDelegation && <p role="alert" className="text-xs text-amber-600">{t('capabilities.noDelegationTool')}</p>}
      <NamePicker label={t('capabilities.mcpServers')} options={catalogs.mcpServers} selected={value.mcpServers} onChange={(mcpServers) => set({ mcpServers })} />
      {showSkills && <NamePicker label={t('capabilities.skills')} options={catalogs.skills} selected={value.skills} onChange={(skills) => set({ skills })} />}
      <ProfileField label={t('capabilities.model')} htmlFor="profile-model">
        <select
          id="profile-model"
          value={value.model}
          onChange={(event) => set({ model: event.target.value })}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">{t('capabilities.modelDefault')}</option>
          {models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </ProfileField>
    </div>
  );
}
