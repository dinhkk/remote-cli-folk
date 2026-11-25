import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';

import type { NewChatScopeState } from '@/modules/agent-profiles';
import type { AgentScopeOption } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type ComposerAgentMenuProps = {
  /** State from `useNewChatScope`; the menu renders nothing until the agent list has been read, or when the project has no agents. */
  state: NewChatScopeState;
};

type AgentGroup = { label: string; agents: AgentScopeOption[] };

/**
 * Splits the agents into dropdown groups: named groups (the Group of the template an agent was generated from) in
 * alphabetical order, then `systemLabel` last for every agent without one (handmade files, templates without a group).
 * The order of the agents inside a group is kept (orchestrator first, project before personal, then by name).
 */
function groupAgents(agents: AgentScopeOption[], systemLabel: string): AgentGroup[] {
  const named = new Map<string, AgentScopeOption[]>();
  const system: AgentScopeOption[] = [];
  for (const agent of agents) {
    const group = agent.group?.trim();
    if (!group || group.toLowerCase() === systemLabel.toLowerCase()) {
      system.push(agent);
    } else {
      named.set(group, [...(named.get(group) ?? []), agent]);
    }
  }
  const groups = [...named.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, members]) => ({ label, agents: members }));
  return system.length > 0 ? [...groups, { label: systemLabel, agents: system }] : groups;
}

/**
 * Main-agent picker of a brand-new chat, in the composer toolbar and in the style of the model menu:
 * `Auto` (Claude Code picks an agent per task, the default) or one agent the open project (and `~/.claude/agents`)
 * offers, which then works the whole chat itself. Agents are listed under group headings (see `groupAgents`); a single
 * group needs no heading. A project without agent files shows nothing: there is nothing to choose.
 * Rendered by chat's ChatComposer for a chat that has no session yet; an open session shows SessionScopeBadge instead.
 */
export default function ComposerAgentMenu({ state }: ComposerAgentMenuProps) {
  const { t } = useTranslation('agentProfiles');
  const [isOpen, setIsOpen] = useState(false);
  const [manualCollapse, setManualCollapse] = useState<Record<string, boolean>>({});
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  if (state.status !== 'ready' || state.agents.length === 0) {
    return null;
  }

  const label = state.agentName ?? t('scope.auto');
  const ariaLabel = t('scope.label');
  const systemLabel = t('scope.groupSystem');
  const groups = groupAgents(state.agents, systemLabel);
  // Named groups start expanded and System starts collapsed; a click on a heading overrides that until the chat is left.
  const isCollapsed = (group: AgentGroup) => manualCollapse[group.label] ?? group.label === systemLabel;
  const toggle = (group: AgentGroup) => setManualCollapse((current) => ({ ...current, [group.label]: !isCollapsed(group) }));
  const pick = (name: string | null) => {
    state.setAgentName(name);
    setIsOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-7 max-w-28 shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted sm:max-w-44"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`${ariaLabel}: ${label}`}
        title={`${ariaLabel}: ${label}`}
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <ComposerMenuHeading>{ariaLabel}</ComposerMenuHeading>
          <ComposerMenuItem
            label={t('scope.auto')}
            description={t('scope.autoHint')}
            isSelected={state.agentName === null}
            onSelect={() => pick(null)}
          />
          {groups.map((group) => {
            const hasHeading = groups.length > 1;
            const collapsed = hasHeading && isCollapsed(group);
            return (
              <div key={group.label} role="group" aria-label={hasHeading ? group.label : undefined}>
                {hasHeading && (
                  <button
                    type="button"
                    onClick={() => toggle(group)}
                    aria-expanded={!collapsed}
                    className="flex w-full items-center gap-1 rounded-lg px-2 pb-1 pt-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />}
                    <span className="truncate">{group.label}</span>
                    <span className="ml-auto shrink-0 tabular-nums opacity-70">{group.agents.length}</span>
                  </button>
                )}
                {!collapsed && group.agents.map((agent) => (
                  <ComposerMenuItem
                    key={agent.name}
                    // Agents sit one step in from their group heading; with a single group there is no heading to indent under.
                    className={hasHeading ? 'pl-6' : undefined}
                    label={agent.isOrchestrator ? t('scope.orchestratorOption', { name: agent.name }) : agent.name}
                    isSelected={state.agentName === agent.name}
                    onSelect={() => pick(agent.name)}
                  />
                ))}
              </div>
            );
          })}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
