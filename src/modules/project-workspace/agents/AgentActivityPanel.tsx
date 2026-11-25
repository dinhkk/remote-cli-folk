import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { RunningActivityContext } from '@/modules/agent-monitor';
import type { SessionStore } from '@/modules/chat';
import type { AppTab, ChatMessage, Project, ProjectSession } from '@/shared/types';
import { SubagentDetailView } from '@/modules/project-workspace/agents/SubagentDetailView';
import { resolveActivityNode } from '@/modules/project-workspace/agents/resolveActivityNode';
import { scrollToToolResult } from '@/modules/project-workspace/agents/scrollToToolResult';
import { useActivityMessages } from '@/modules/project-workspace/agents/useActivityMessages';

type AgentActivityPanelProps = {
  /** The sub-agent the Running pane has focused, and how to open its chat. */
  context: RunningActivityContext;
  sessionStore: SessionStore;
  selectedProject: Project | null;
  /** The chat the workspace has open: the editor belongs to its project, so files open only for that chat. */
  selectedSession: ProjectSession | null;
  sendMessage: (message: unknown) => void;
  setActiveTab: (tab: AppTab) => void;
  onFileOpen: (filePath: string) => void;
};

const nothing = () => undefined;

/**
 * The Activity of one sub-agent shown under the Running pane's graph: the same inspector the workspace's Agents tab had (the
 * prompt, each recorded tool call with its output and diff, stop, view in chat). The monitor names the agent; its recorded
 * work comes from the chat's messages, loaded here for a chat that is not open.
 */
export function AgentActivityPanel({ context, sessionStore, selectedProject, selectedSession, sendMessage, setActiveTab, onFileOpen }: AgentActivityPanelProps) {
  const { t } = useTranslation('agentMonitor');
  const { messages, status } = useActivityMessages(sessionStore, context.chatId, context.running);
  const node = useMemo(() => resolveActivityNode(context.chatId, messages, context.agentId), [context.chatId, context.agentId, messages]);

  if (!node) {
    const key = status === 'loading' ? 'agentActivity.loading' : status === 'error' ? 'agentActivity.error' : 'agentActivity.notFound';
    return <p className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground" role="status" data-testid="agent-activity-state">{t(key)}</p>;
  }

  // Opening the chat leaves the pane (the route's own view comes back), then the chat tab is shown and the row scrolled to.
  const jumpToChat = (message: ChatMessage) => {
    context.openChat();
    setActiveTab('chat');
    if (message.toolId) scrollToToolResult(message.toolId);
  };
  const stopTask = (taskId: string) => sendMessage({ type: 'chat.stop-task', sessionId: context.chatId, taskId });
  const sameChat = selectedSession?.id === context.chatId;
  const openFile = sameChat
    ? (filePath: string) => { context.openChat(); setActiveTab('chat'); onFileOpen(filePath); }
    : nothing;

  return (
    // A narrow pane gives the Activity the whole view (it fills what the Back row leaves); else a fixed-height section under the graph.
    <div className={`${context.fill ? 'h-full min-h-[320px]' : 'h-[min(32rem,70vh)]'} overflow-hidden rounded-lg border border-border/60 bg-background`} data-testid="agent-activity">
      <SubagentDetailView
        selectedNode={node}
        message={node.message}
        selectedProject={selectedProject}
        onFileOpen={openFile}
        onJumpToChat={jumpToChat}
        onStopTask={stopTask}
      />
    </div>
  );
}
