import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { AgentScopeOption, AgentScopeOptions, NewChatScopeRequest } from '@/shared/types';

/** What the new-chat main-agent picker shows and what the composer sends; see {@link useNewChatScope}. */
export type NewChatScopeState = {
  /** `idle` while the picker is not in use, `error` when the agent list could not be read (the chat then stays a plain chat). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Main agents the open project offers (orchestrators first); empty until the list has been read. */
  agents: AgentScopeOption[];
  /** The chosen main agent's name; null = none. */
  agentName: string | null;
  setAgentName: (name: string | null) => void;
  /** What the composer needs at send time. */
  request: NewChatScopeRequest;
};

type UseNewChatScopeArgs = {
  /** `Project.projectId` of the project open in the sidebar, or null when none is. */
  projectId: string | null;
  /** True only while a brand-new Claude chat is on screen; the agent list is read each time it becomes true. */
  enabled: boolean;
};

/** Orchestrators first, the rest in the server's order (project agents, then personal ones, each by name). */
const orchestratorsFirst = (agents: AgentScopeOption[]): AgentScopeOption[] => [
  ...agents.filter((agent) => agent.isOrchestrator),
  ...agents.filter((agent) => !agent.isOrchestrator),
];

/**
 * State of the new-chat main-agent picker: reads the agents the open sidebar project offers (`scope-options`, open to
 * Remote) when a new Claude chat opens, lets the user pick one or none (none is the default: a plain Claude Code chat), and
 * turns the answer into what the composer sends, `scope: { agentName }`. Once the list has been read the scope is always
 * sent, with `agentName: null` for "none", so the user's hidden agents stay hidden in every chat. Nothing is sent while the
 * list is loading, failed or unused (another provider, an open session): that chat is an ordinary one.
 * Used by chat's ChatInterface, which renders ScopePicker and hands `request` to the composer.
 */
export function useNewChatScope({ projectId, enabled }: UseNewChatScopeArgs): NewChatScopeState {
  // The agents read for `forProject`, or 'error'; keeping the id lets an answer for another project be ignored.
  // A re-read keeps the previous list on screen meanwhile so the picker does not flash empty.
  const [read, setRead] = useState<{ forProject: string; agents: AgentScopeOption[] | 'error' } | null>(null);
  // A choice made by hand, tied to the project it was made for: another project is another chat.
  const [picked, setPicked] = useState<{ forProject: string; name: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !projectId) return undefined;
    let cancelled = false;
    api.agentProfiles.scopeOptions(projectId)
      .then((response) => readApiJson<Partial<AgentScopeOptions>>(response))
      .then(
        (answer) => {
          if (!cancelled) setRead({ forProject: projectId, agents: orchestratorsFirst(Array.isArray(answer.agents) ? answer.agents : []) });
        },
        () => { if (!cancelled) setRead({ forProject: projectId, agents: 'error' }); },
      );
    return () => {
      cancelled = true;
      // The chat this choice was made for has ended (a session now exists, or the provider changed): the next new chat starts from "none" again.
      setPicked(null);
    };
  }, [enabled, projectId]);

  const answer = read && read.forProject === projectId ? read.agents : null;
  const status: NewChatScopeState['status'] = !enabled || !projectId
    ? 'idle'
    : answer === null ? 'loading' : answer === 'error' ? 'error' : 'ready';
  const agents = useMemo<AgentScopeOption[]>(() => (Array.isArray(answer) ? answer : []), [answer]);

  // A hand-picked agent that is no longer on the list (hidden or deleted meanwhile) falls back to none.
  const agentName = picked && picked.forProject === projectId && agents.some((agent) => agent.name === picked.name) ? picked.name : null;
  const setAgentName = useCallback((name: string | null) => {
    if (projectId) setPicked({ forProject: projectId, name });
  }, [projectId]);

  const request = useMemo<NewChatScopeRequest>(
    () => (status === 'ready' ? { scope: { agentName } } : {}),
    [agentName, status],
  );

  return { status, agents, agentName, setAgentName, request };
}
