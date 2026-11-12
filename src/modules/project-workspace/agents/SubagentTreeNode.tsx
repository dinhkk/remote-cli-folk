import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Layers,
  Loader2,
  MessageSquare,
  Pencil,
  Search,
  Square,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';

import type { ChatMessage } from '@/shared/types';
import {
  formatTaskDuration,
  parseToolPayload,
  readBackgroundTaskId,
  readBackgroundTaskStatus,
} from '@/modules/chat';
import type { AgentTreeNode } from '@/modules/project-workspace/agents/agentTreeTypes';

type SubagentTreeNodeProps = {
  node?: AgentTreeNode;
  message?: ChatMessage; // fallback for backwards compatibility
  isSelected?: boolean;
  selectedNodeId?: string | null;
  expandedNodeIds?: Set<string>;
  onToggleExpand?: (nodeId: string) => void;
  onSelectNode?: (node: AgentTreeNode) => void;
  onSelect?: (message: ChatMessage) => void; // fallback for backwards compatibility
  onJumpToChat: (message: ChatMessage) => void;
  onStopTask: (taskId: string) => void;
};

export const SubagentTreeNode = memo(({
  node: propNode,
  message: propMessage,
  isSelected: propIsSelected,
  selectedNodeId,
  expandedNodeIds,
  onToggleExpand,
  onSelectNode,
  onSelect,
  onJumpToChat,
  onStopTask,
}: SubagentTreeNodeProps) => {
  const { t } = useTranslation();

  // If node was not provided, build a single node from message for backwards compatibility
  const node: AgentTreeNode = useMemo(() => {
    if (propNode) return propNode;
    if (propMessage) {
      const parsed = parseToolPayload(propMessage.toolInput) as Record<string, unknown> | null;
      const status = readBackgroundTaskStatus(propMessage) || propMessage.subagent?.status || 'completed';
      const durationMs = propMessage.taskStatus?.usage?.durationMs;
      const type = propMessage.workflow || propMessage.toolName === 'Workflow'
        ? 'workflow'
        : (propMessage.toolName === 'Bash' && readBackgroundTaskStatus(propMessage) !== undefined)
          ? 'background_task'
          : 'subagent';

      const label = propMessage.subagent?.type
        || (typeof parsed?.subagent_type === 'string' ? parsed.subagent_type : '')
        || propMessage.workflow?.name
        || propMessage.toolName
        || 'Agent';

      const subtitle = propMessage.subagent?.description
        || (typeof parsed?.description === 'string' ? parsed.description : '')
        || propMessage.workflow?.description
        || (typeof parsed?.command === 'string' ? parsed.command : '')
        || '';

      return {
        id: propMessage.subagent?.id || propMessage.toolId || `node-${propMessage.timestamp}`,
        type,
        label,
        subtitle,
        status,
        model: propMessage.subagent?.model,
        durationMs,
        message: propMessage,
        depth: 0,
        children: [],
      };
    }

    return {
      id: 'empty',
      type: 'subagent',
      label: 'Agent',
      status: 'completed',
      depth: 0,
      children: [],
    };
  }, [propNode, propMessage]);

  const isSelected = propIsSelected ?? (selectedNodeId === node.id);
  const isExpanded = expandedNodeIds ? expandedNodeIds.has(node.id) : true;
  const hasChildren = node.children.length > 0;

  const taskId = node.message ? readBackgroundTaskId(node.message) : undefined;

  const handleRowClick = () => {
    if (onSelectNode) {
      onSelectNode(node);
    }
    if (node.message && onSelect) {
      onSelect(node.message);
    }
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleExpand) {
      onToggleExpand(node.id);
    }
  };

  const getStatusIcon = () => {
    switch (node.status) {
      case 'running':
        return <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-500" />;
      case 'completed':
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
      case 'failed':
        return <XCircle className="h-3.5 w-3.5 text-rose-500" />;
      case 'stopped':
        return <Square className="h-3 w-3 text-muted-foreground" />;
      default:
        return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  const getNodeIcon = () => {
    switch (node.type) {
      case 'root':
        return <Bot className="h-4 w-4 text-purple-600 dark:text-purple-400" />;
      case 'workflow':
        return <Layers className="h-4 w-4 text-indigo-500" />;
      case 'workflow_agent':
        return <Bot className="h-3.5 w-3.5 text-indigo-400" />;
      case 'background_task':
        return <Terminal className="h-4 w-4 text-amber-500" />;
      case 'activity': {
        const lowerLabel = node.label.toLowerCase();
        if (lowerLabel.includes('read')) return <FileText className="h-3.5 w-3.5 text-sky-500" />;
        if (lowerLabel.includes('edit') || lowerLabel.includes('write')) return <Pencil className="h-3.5 w-3.5 text-emerald-500" />;
        if (lowerLabel.includes('bash')) return <Terminal className="h-3.5 w-3.5 text-amber-500" />;
        if (lowerLabel.includes('grep') || lowerLabel.includes('search') || lowerLabel.includes('glob')) return <Search className="h-3.5 w-3.5 text-violet-500" />;
        if (lowerLabel.includes('think')) return <Brain className="h-3.5 w-3.5 text-pink-500" />;
        if (lowerLabel.includes('text')) return <MessageSquare className="h-3.5 w-3.5 text-blue-500" />;
        return <Wrench className="h-3.5 w-3.5 text-muted-foreground" />;
      }
      case 'subagent':
      default:
        return <Bot className="h-4 w-4 text-purple-500" />;
    }
  };

  const indentPadding = Math.min(node.depth * 16 + 6, 80);

  return (
    <div className="flex flex-col select-none">
      <div
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected}
        tabIndex={0}
        onClick={handleRowClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleRowClick();
          } else if (e.key === 'ArrowRight' && hasChildren && !isExpanded && onToggleExpand) {
            e.preventDefault();
            onToggleExpand(node.id);
          } else if (e.key === 'ArrowLeft' && hasChildren && isExpanded && onToggleExpand) {
            e.preventDefault();
            onToggleExpand(node.id);
          }
        }}
        style={{ paddingLeft: `${indentPadding}px` }}
        className={`group relative flex items-center justify-between gap-1.5 py-1.5 pr-2 transition-colors cursor-pointer rounded-sm outline-none ${
          isSelected
            ? 'bg-primary/10 text-primary font-medium dark:bg-primary/15'
            : 'hover:bg-muted/60 text-foreground'
        }`}
      >
        {/* Tree branch vertical guide line for nested nodes */}
        {node.depth > 0 && (
          <div
            aria-hidden="true"
            style={{ left: `${indentPadding - 10}px` }}
            className="absolute top-0 bottom-0 w-px bg-border/40 pointer-events-none group-hover:bg-border/70"
          />
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* Chevron expand/collapse toggle */}
          {hasChildren ? (
            <button
              type="button"
              onClick={handleToggleClick}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
            </span>
          )}

          {/* Node Icon & Status Icon */}
          <div className="flex shrink-0 items-center gap-1.5">
            {getNodeIcon()}
            {getStatusIcon()}
          </div>

          {/* Node Label and Badges */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`truncate text-xs ${node.type === 'root' ? 'font-bold tracking-tight text-foreground' : 'font-medium'}`}>
                {node.label}
              </span>

              {node.model && (
                <span className="rounded bg-muted px-1.5 py-0.2 text-[10px] uppercase font-mono text-muted-foreground">
                  {node.model}
                </span>
              )}

              {node.status === 'running' && (
                <span className="inline-flex items-center rounded-full bg-purple-500/15 px-1.5 py-0.2 text-[9px] font-semibold text-purple-600 dark:text-purple-400">
                  Running
                </span>
              )}

              {node.type === 'root' && node.children.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground font-mono">
                  {node.children.length}
                </span>
              )}
            </div>

            {node.subtitle && (
              <p className="truncate text-[10px] text-muted-foreground leading-tight">
                {node.subtitle}
              </p>
            )}
          </div>
        </div>

        {/* Right side actions: duration, stop, jump to chat */}
        <div className="flex shrink-0 items-center gap-0.5">
          {typeof node.durationMs === 'number' && node.durationMs > 0 && (
            <span className="text-[10px] text-muted-foreground mr-1">
              {formatTaskDuration(node.durationMs)}
            </span>
          )}

          {node.status === 'running' && taskId && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStopTask(taskId);
              }}
              title={t('workflow.stopTask', 'Stop task')}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          )}

          {node.message && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (node.message) onJumpToChat(node.message);
              }}
              title={t('agents.jumpToChat', 'View in Chat')}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Recursive rendering of child branches */}
      {isExpanded && hasChildren && (
        <div role="group" className="flex flex-col">
          {node.children.map((childNode) => (
            <SubagentTreeNode
              key={childNode.id}
              node={childNode}
              selectedNodeId={selectedNodeId}
              expandedNodeIds={expandedNodeIds}
              onToggleExpand={onToggleExpand}
              onSelectNode={onSelectNode}
              onJumpToChat={onJumpToChat}
              onStopTask={onStopTask}
            />
          ))}
        </div>
      )}
    </div>
  );
});

SubagentTreeNode.displayName = 'SubagentTreeNode';
