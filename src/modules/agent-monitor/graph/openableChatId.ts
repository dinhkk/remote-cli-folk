import type { AgentMonitorSession } from '@/shared/types';

/**
 * The app chat a graph box opens. The graph names sessions by their monitor id; a terminal session the app has no chat for
 * has no chat id, so a click on it opens nothing.
 */
export const openableChatId = (sessions: AgentMonitorSession[], monitorSessionId: string): string | null =>
  sessions.find((session) => session.id === monitorSessionId)?.openSessionId ?? null;
