import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Bot,
  Clock,
  ExternalLink,
  Layers,
  Square,
  Wrench,
} from 'lucide-react';

import type { ChatMessage, Project, SubagentActivity } from '@/shared/types';
import {
  SubagentTimeline,
  createCachedDiffCalculator,
  formatTaskDuration,
  parseToolPayload,
  readBackgroundTaskId,
  readBackgroundTaskStatus,
} from '@/modules/chat';
import type { AgentTreeNode } from '@/modules/project-workspace/agents/agentTreeTypes';

type SubagentDetailViewProps = {
  selectedNode?: AgentTreeNode | null;
  message?: ChatMessage | null;
  selectedProject: Project | null;
  onFileOpen: (filePath: string) => void;
  onJumpToChat: (message: ChatMessage) => void;
  onStopTask: (taskId: string) => void;
};

export const SubagentDetailView = memo(({
  selectedNode,
  message: propMessage,
  selectedProject,
  onFileOpen,
  onJumpToChat,
  onStopTask,
}: SubagentDetailViewProps) => {
  const { t } = useTranslation();
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);

  // Determine active node and message
  const activeMessage = selectedNode?.message || propMessage || null;

  if (!selectedNode && !activeMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <Bot className="h-10 w-10 text-muted-foreground/30 mb-2" />
        <p className="text-sm font-medium">{t('agents.selectAgent', 'Select an agent or task to view details')}</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
          Click any node in the tree to inspect its prompt, activities, or tool outputs.
        </p>
      </div>
    );
  }

  // 1. Activity Node Inspector: Tool Execution View
  if (selectedNode && selectedNode.type === 'activity' && selectedNode.activity) {
    const act = selectedNode.activity;
    const toolName = act.toolName || (act.kind === 'tool' ? 'Tool' : act.kind);
    const inputContent = typeof act.toolInput === 'string'
      ? act.toolInput
      : act.toolInput
        ? JSON.stringify(act.toolInput, null, 2)
        : '';
    const resultContent = typeof act.toolResult?.content === 'string'
      ? act.toolResult.content
      : act.toolResult?.content
        ? JSON.stringify(act.toolResult.content, null, 2)
        : (act.content || '');
    const isError = Boolean(act.toolResult?.isError);

    return (
      <div className="flex h-full flex-col overflow-y-auto bg-background">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border/60 p-4 bg-muted/10">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <Wrench className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold truncate font-mono">{toolName}</h2>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                  isError ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                }`}>
                  {isError ? 'Failed' : 'Success'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                Tool Execution Step
              </p>
            </div>
          </div>

          {activeMessage && (
            <button
              type="button"
              onClick={() => onJumpToChat(activeMessage)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              <span>{t('agents.viewInChat', 'View in Chat')}</span>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 p-4 space-y-4">
          {inputContent && (
            <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Input Arguments
              </h3>
              <pre className="max-h-60 overflow-y-auto rounded bg-background/80 p-2 text-xs font-mono text-foreground whitespace-pre-wrap">
                {inputContent}
              </pre>
            </div>
          )}

          <div className="rounded-lg border border-border/50 bg-background p-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              Result Output
            </h3>
            {resultContent ? (
              <pre className="max-h-96 overflow-y-auto rounded bg-muted/30 p-2 text-xs font-mono text-foreground whitespace-pre-wrap">
                {resultContent}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground italic py-2">No output recorded.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 2. Subagent / Workflow / Background Task View
  const parsedInput = activeMessage ? (parseToolPayload(activeMessage.toolInput) as Record<string, unknown> | null) : null;
  const status = selectedNode?.status
    || (activeMessage ? readBackgroundTaskStatus(activeMessage) : null)
    || activeMessage?.subagent?.status
    || 'completed';

  const taskId = activeMessage ? readBackgroundTaskId(activeMessage) : undefined;
  const prompt = typeof parsedInput?.prompt === 'string' ? parsedInput.prompt : '';
  const description = selectedNode?.subtitle
    || activeMessage?.subagent?.description
    || (typeof parsedInput?.description === 'string' ? parsedInput.description : '')
    || activeMessage?.workflow?.description
    || (typeof parsedInput?.command === 'string' ? parsedInput.command : '')
    || '';

  const label = selectedNode?.label
    || activeMessage?.subagent?.type
    || (typeof parsedInput?.subagent_type === 'string' ? parsedInput.subagent_type : '')
    || (activeMessage?.toolName === 'Workflow' ? 'Workflow' : activeMessage?.toolName || 'Agent');

  const activities: SubagentActivity[] = Array.isArray(activeMessage?.subagentActivity) ? activeMessage.subagentActivity : [];
  const durationMs = selectedNode?.durationMs ?? activeMessage?.taskStatus?.usage?.durationMs;

  const isWorkflow = selectedNode?.type === 'workflow' || activeMessage?.workflow || activeMessage?.toolName === 'Workflow';

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/60 p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
            {isWorkflow ? <Layers className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold truncate">{label}</h2>
              {(selectedNode?.model || activeMessage?.subagent?.model) && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">
                  {selectedNode?.model || activeMessage?.subagent?.model}
                </span>
              )}
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                status === 'running'
                  ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400'
                  : status === 'completed'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}>
                {status}
              </span>
            </div>
            {description && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">{description}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {status === 'running' && taskId && (
            <button
              type="button"
              onClick={() => onStopTask(taskId)}
              className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors"
            >
              <Square className="h-3 w-3 fill-current" />
              <span>{t('workflow.stopTask', 'Stop')}</span>
            </button>
          )}
          {activeMessage && (
            <button
              type="button"
              onClick={() => onJumpToChat(activeMessage)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              <span>{t('agents.viewInChat', 'View in Chat')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-4 space-y-4">
        {/* Prompt */}
        {prompt && (
          <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              Task Prompt
            </h3>
            <p className="text-xs whitespace-pre-wrap text-foreground font-mono leading-relaxed">
              {prompt}
            </p>
          </div>
        )}

        {/* Workflow Agents List (if workflow) */}
        {isWorkflow && activeMessage?.workflow?.agents && activeMessage.workflow.agents.length > 0 && (
          <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-indigo-500" />
              <span>Workflow Agents ({activeMessage.workflow.agents.length})</span>
            </h3>
            <div className="divide-y divide-border/30">
              {activeMessage.workflow.agents.map((ag) => (
                <div key={ag.id} className="flex items-center justify-between py-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{ag.label || ag.id}</span>
                    {ag.phase && <span className="text-[10px] text-muted-foreground">({ag.phase})</span>}
                  </div>
                  <span className={`text-[10px] font-medium capitalize ${
                    ag.status === 'completed' ? 'text-emerald-500' : ag.status === 'running' ? 'text-purple-500' : 'text-muted-foreground'
                  }`}>
                    {ag.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timeline of tool activities */}
        <div className="rounded-lg border border-border/50 bg-background p-3">
          <div className="flex items-center justify-between mb-3 border-b border-border/40 pb-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Wrench className="h-3.5 w-3.5" />
              <span>Recorded Activities ({activities.length})</span>
            </h3>
            {typeof durationMs === 'number' && durationMs > 0 ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatTaskDuration(durationMs)}
              </span>
            ) : null}
          </div>

          {activities.length > 0 ? (
            <div className="space-y-2">
              <SubagentTimeline
                activity={activities}
                activityCount={activeMessage?.subagent?.activityCount}
                onFileOpen={onFileOpen}
                createDiff={createDiff}
                selectedProject={selectedProject ?? undefined}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic py-2">
              No tool activities recorded yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
});

SubagentDetailView.displayName = 'SubagentDetailView';
export default SubagentDetailView;
