import { memo, useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronsDownUp, ChevronsUpDown, Filter } from 'lucide-react';

import type { ChatMessage, ProjectSession } from '@/shared/types';
import { SubagentTreeNode } from '@/modules/project-workspace/agents/SubagentTreeNode';
import type { AgentTreeNode } from '@/modules/project-workspace/agents/agentTreeTypes';
import {
  buildAgentTree,
  collectAllNodeIds,
  countTreeStats,
} from '@/modules/project-workspace/agents/agentTreeUtils';

type SubagentTreeListProps = {
  treeNodes?: AgentTreeNode[];
  session?: ProjectSession | null;
  messages?: ChatMessage[];
  selectedNodeId?: string | null;
  selectedMessage?: ChatMessage | null;
  onSelectNode?: (node: AgentTreeNode) => void;
  onSelectMessage?: (message: ChatMessage) => void;
  onJumpToChat: (message: ChatMessage) => void;
  onStopTask: (taskId: string) => void;
};

export const SubagentTreeList = memo(({
  treeNodes: propTreeNodes,
  session = null,
  messages = [],
  selectedNodeId,
  selectedMessage,
  onSelectNode,
  onSelectMessage,
  onJumpToChat,
  onStopTask,
}: SubagentTreeListProps) => {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'completed' | 'failed'>('all');

  // Compute tree from session and messages if propTreeNodes is not provided
  const treeNodes = useMemo(() => {
    if (propTreeNodes) return propTreeNodes;
    return buildAgentTree(session, messages);
  }, [propTreeNodes, session, messages]);

  // Expanded nodes state
  const allNodeIds = useMemo(() => collectAllNodeIds(treeNodes), [treeNodes]);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set(allNodeIds));

  // Expand new nodes automatically when tree updates
  useEffect(() => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      allNodeIds.forEach((id) => next.add(id));
      return next;
    });
  }, [allNodeIds]);

  const handleToggleExpand = useCallback((nodeId: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedNodeIds(new Set(allNodeIds));
  }, [allNodeIds]);

  const handleCollapseAll = useCallback(() => {
    // Keep root node expanded so the tree remains accessible
    const rootOnly = new Set<string>();
    treeNodes.forEach((root) => rootOnly.add(root.id));
    setExpandedNodeIds(rootOnly);
  }, [treeNodes]);

  // Compute stats
  const stats = useMemo(() => countTreeStats(treeNodes), [treeNodes]);

  // Filter tree nodes if status filter is active
  const filteredNodes = useMemo(() => {
    if (statusFilter === 'all') return treeNodes;

    return treeNodes
      .map((root) => {
        const matchingChildren = root.children.filter((child) => {
          if (child.status === statusFilter) return true;
          return child.children.some((sub) => sub.status === statusFilter);
        });

        if (matchingChildren.length === 0 && root.status !== statusFilter) return null;

        return {
          ...root,
          children: matchingChildren,
        };
      })
      .filter((n): n is AgentTreeNode => n !== null);
  }, [treeNodes, statusFilter]);

  if (treeNodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <Bot className="h-10 w-10 stroke-[1.5] text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-foreground">{t('agents.emptyTitle', 'No Subagents or Background Tasks')}</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {t('agents.emptyDesc', 'When the main agent spawns subagents, workflows, or background processes, they will appear here.')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tree Control Toolbar */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5 bg-muted/20 text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Filter className="h-3 w-3" />
          <div className="flex items-center gap-1">
            {(['all', 'running', 'completed', 'failed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize transition-colors ${
                  statusFilter === s
                    ? 'bg-primary/15 text-primary font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {s}
                {s === 'running' && stats.running > 0 && (
                  <span className="ml-1 text-purple-600 dark:text-purple-400 font-bold">({stats.running})</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleExpandAll}
            title={t('agents.expandAll', 'Expand all')}
            aria-label={t('agents.expandAll', 'Expand all')}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCollapseAll}
            title={t('agents.collapseAll', 'Collapse all')}
            aria-label={t('agents.collapseAll', 'Collapse all')}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Tree Content */}
      <div
        role="tree"
        aria-label="Agents Tree"
        className="flex-1 overflow-y-auto py-1 px-1"
      >
        {filteredNodes.map((rootNode) => (
          <SubagentTreeNode
            key={rootNode.id}
            node={rootNode}
            selectedNodeId={selectedNodeId}
            isSelected={selectedMessage ? rootNode.message?.toolId === selectedMessage.toolId : undefined}
            expandedNodeIds={expandedNodeIds}
            onToggleExpand={handleToggleClickNode}
            onSelectNode={onSelectNode}
            onSelect={onSelectMessage}
            onJumpToChat={onJumpToChat}
            onStopTask={onStopTask}
          />
        ))}
      </div>
    </div>
  );

  function handleToggleClickNode(nodeId: string) {
    handleToggleExpand(nodeId);
  }
});

SubagentTreeList.displayName = 'SubagentTreeList';
