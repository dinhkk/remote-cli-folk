import { memo, useMemo, useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';

import type { AppTab, ChatMessage, Project, ProjectSession } from '@/shared/types';
import {
  useSessionStore,
  type SessionStore,
  normalizedToChatMessages,
} from '@/modules/chat';
import { SubagentTreeList } from '@/modules/project-workspace/agents/SubagentTreeList';
import { SubagentDetailView } from '@/modules/project-workspace/agents/SubagentDetailView';
import type { AgentTreeNode } from '@/modules/project-workspace/agents/agentTreeTypes';
import { buildAgentTree, findNodeInTree } from '@/modules/project-workspace/agents/agentTreeUtils';

type AgentsWorkspaceViewProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  sendMessage: (message: unknown) => void;
  onFileOpen: (filePath: string) => void;
  sessionStore?: SessionStore | null;
};

export const AgentsWorkspaceView = memo(({
  selectedProject,
  selectedSession,
  setActiveTab,
  sendMessage,
  onFileOpen,
  sessionStore: propsSessionStore,
}: AgentsWorkspaceViewProps) => {
  const { t } = useTranslation();
  const localSessionStore = useSessionStore();
  const sessionStore = propsSessionStore || localSessionStore;
  const [selectedNode, setSelectedNode] = useState<AgentTreeNode | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);

  const sessionId = selectedSession?.id;

  const messages: ChatMessage[] = useMemo(() => {
    if (!sessionId) return [];
    const normalized = sessionStore.getMessages(sessionId);
    return normalizedToChatMessages(normalized);
  }, [sessionId, sessionStore]);

  // Construct hierarchical agent tree (Root -> Subagents / Workflows / Tasks -> Activities)
  const treeNodes = useMemo(() => {
    return buildAgentTree(selectedSession, messages);
  }, [selectedSession, messages]);

  // Auto-select latest task or root node if none selected
  useEffect(() => {
    if (treeNodes.length === 0) {
      setSelectedNode(null);
      setSelectedMessage(null);
      return;
    }

    const root = treeNodes[0];
    if (!selectedNode) {
      // Pick first child if exists, else root
      const initialNode = root.children[0] ?? root;
      setSelectedNode(initialNode);
      if (initialNode.message) {
        setSelectedMessage(initialNode.message);
      }
    } else {
      // Check if previously selected node still exists in tree
      const updated = findNodeInTree(treeNodes, selectedNode.id);
      if (updated) {
        setSelectedNode(updated);
        if (updated.message) {
          setSelectedMessage(updated.message);
        }
      } else {
        const fallback = root.children[root.children.length - 1] ?? root;
        setSelectedNode(fallback);
        if (fallback.message) {
          setSelectedMessage(fallback.message);
        }
      }
    }
  }, [treeNodes, selectedNode]);

  const handleSelectNode = (node: AgentTreeNode) => {
    setSelectedNode(node);
    if (node.message) {
      setSelectedMessage(node.message);
    }
  };

  const handleSelectMessage = (message: ChatMessage) => {
    setSelectedMessage(message);
  };

  const handleJumpToChat = (message: ChatMessage) => {
    setActiveTab('chat');
    if (message.toolId) {
      setTimeout(() => {
        const el = document.getElementById(`tool-result-${message.toolId}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    }
  };

  const handleStopTask = (taskId: string) => {
    if (sessionId) {
      sendMessage({ type: 'chat.stop-task', sessionId, taskId });
    }
  };

  if (!selectedSession) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <Bot className="h-10 w-10 text-muted-foreground/30 mb-2" />
        <p className="text-sm font-medium">{t('agents.noSession', 'No session selected')}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {t('agents.selectSessionDesc', 'Select or start a chat session to monitor its agents.')}
        </p>
      </div>
    );
  }

  const childTasksCount = treeNodes[0]?.children.length ?? 0;

  return (
    <div className="flex h-full w-full overflow-hidden divide-x divide-border/60 bg-background">
      {/* Left panel: Tree List */}
      <div className="flex w-full md:w-80 lg:w-96 flex-shrink-0 flex-col overflow-hidden bg-muted/10">
        <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2.5 bg-muted/20">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-purple-500" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('agents.tabTitle', 'Agents & Tasks')}
            </h2>
          </div>
          <span className="text-[11px] font-medium text-muted-foreground">
            {childTasksCount} {childTasksCount === 1 ? 'task' : 'tasks'}
          </span>
        </div>

        <div className="flex-1 overflow-hidden">
          <SubagentTreeList
            treeNodes={treeNodes}
            session={selectedSession}
            messages={messages}
            selectedNodeId={selectedNode?.id}
            selectedMessage={selectedMessage}
            onSelectNode={handleSelectNode}
            onSelectMessage={handleSelectMessage}
            onJumpToChat={handleJumpToChat}
            onStopTask={handleStopTask}
          />
        </div>
      </div>

      {/* Right panel: Detail Inspector */}
      <div className="hidden md:flex flex-1 flex-col overflow-hidden">
        <SubagentDetailView
          selectedNode={selectedNode}
          message={selectedMessage}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          onFileOpen={onFileOpen}
          onJumpToChat={handleJumpToChat}
          onStopTask={handleStopTask}
        />
      </div>
    </div>
  );
});

AgentsWorkspaceView.displayName = 'AgentsWorkspaceView';
export default AgentsWorkspaceView;
