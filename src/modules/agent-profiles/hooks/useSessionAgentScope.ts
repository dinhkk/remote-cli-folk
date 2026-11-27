import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SessionAgentScopeInfo } from '@/shared/types';

type SessionDetailsAnswer = { data?: { agentScope?: SessionAgentScopeInfo | null } };

/**
 * Looks up the main agent an open session was started with: the session details carry `agentScope`, null for a chat
 * without a scope. Returns the agent's name, or null while unknown, for a chat without a main agent, or when the lookup
 * failed: the label is information, never a reason to break the chat.
 * Used by chat's ChatInterface for the locked agent button of an open session's composer.
 */
export function useSessionAgentScope(sessionId: string | null, enabled: boolean): string | null {
  // The name found for `forSession`; keeping the id lets a stale answer for the previous session be ignored on a switch.
  const [found, setFound] = useState<{ forSession: string; agentName: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    (async () => {
      let agentName: string | null = null;
      try {
        const details = await readApiJson<SessionDetailsAnswer>(await api.sessionDetails(sessionId));
        const name = details.data?.agentScope?.agentName;
        agentName = typeof name === 'string' && name ? name : null;
      } catch {
        agentName = null;
      }
      if (!cancelled) setFound({ forSession: sessionId, agentName });
    })();
    return () => { cancelled = true; };
  }, [enabled, sessionId]);

  return enabled && sessionId && found?.forSession === sessionId ? found.agentName : null;
}
