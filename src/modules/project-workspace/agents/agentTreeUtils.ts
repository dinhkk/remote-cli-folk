import type { ChatMessage, ProjectSession, SubagentActivity } from '@/shared/types';
import {
  parseToolPayload,
  readBackgroundTaskId,
  readBackgroundTaskStatus,
} from '@/modules/chat';
import type { AgentTreeNode } from '@/modules/project-workspace/agents/agentTreeTypes';
import { isAgentTaskMessage } from '@/modules/project-workspace/agents/agentTaskUtils';

export function buildAgentTree(
  session: ProjectSession | null,
  messages: ChatMessage[],
): AgentTreeNode[] {
  if (!session) return [];

  const agentTasks = messages.filter(isAgentTaskMessage);
  if (agentTasks.length === 0) return [];

  const childNodes: AgentTreeNode[] = [];

  agentTasks.forEach((task, taskIdx) => {
    const parsedInput = parseToolPayload(task.toolInput) as Record<string, unknown> | null;
    const taskStatus = readBackgroundTaskStatus(task) || task.subagent?.status || task.workflow?.status || 'completed';
    const durationMs = task.taskStatus?.usage?.durationMs;
    const activities: SubagentActivity[] = Array.isArray(task.subagentActivity) ? task.subagentActivity : [];

    // Case 1: Workflow execution
    if (task.workflow || task.toolName === 'Workflow') {
      const wfId = task.workflow?.runId || task.toolId || `wf-${task.timestamp || taskIdx}`;
      const wfAgents = task.workflow?.agents ?? [];

      const wfAgentNodes: AgentTreeNode[] = wfAgents.map((ag) => ({
        id: `wf-ag-${wfId}-${ag.id}`,
        type: 'workflow_agent',
        label: ag.label || ag.id,
        subtitle: ag.phase ? `Phase: ${ag.phase}` : undefined,
        status: ag.status,
        message: task,
        workflowAgent: ag,
        depth: 2,
        children: [],
      }));

      const activityNodes: AgentTreeNode[] = activities.map((act, actIdx) => {
        const toolName = act.toolName || (act.kind === 'tool' ? 'Tool' : act.kind);
        const inputStr = typeof act.toolInput === 'string'
          ? act.toolInput
          : act.toolInput
            ? JSON.stringify(act.toolInput)
            : '';
        return {
          id: `wf-act-${wfId}-${act.toolId ?? actIdx}`,
          type: 'activity',
          label: toolName,
          subtitle: inputStr ? inputStr.slice(0, 50) : undefined,
          status: act.toolResult?.isError ? 'failed' : 'completed',
          message: task,
          activity: act,
          depth: 2,
          children: [],
        };
      });

      childNodes.push({
        id: `wf-${wfId}`,
        type: 'workflow',
        label: task.workflow?.name || 'Workflow',
        subtitle: task.workflow?.description || (typeof parsedInput?.description === 'string' ? parsedInput.description : undefined),
        status: taskStatus,
        durationMs,
        message: task,
        depth: 1,
        children: [...wfAgentNodes, ...activityNodes],
      });
      return;
    }

    // Case 2: Background Bash task
    if (task.toolName === 'Bash' && readBackgroundTaskStatus(task) !== undefined) {
      const bgId = readBackgroundTaskId(task) || task.toolId || `bg-${task.timestamp || taskIdx}`;
      const command = typeof parsedInput?.command === 'string' ? parsedInput.command : '';
      const desc = typeof parsedInput?.description === 'string' ? parsedInput.description : 'Background Command';

      childNodes.push({
        id: `bg-${bgId}`,
        type: 'background_task',
        label: desc,
        subtitle: command,
        status: taskStatus,
        durationMs,
        message: task,
        depth: 1,
        children: [],
      });
      return;
    }

    // Case 3: Subagent container / Agent tool
    const subagentId = task.subagent?.id || task.toolId || `sub-${task.timestamp || taskIdx}`;
    const agentType = task.subagent?.type
      || (typeof parsedInput?.subagent_type === 'string' ? parsedInput.subagent_type : '')
      || 'Subagent';
    const description = task.subagent?.description
      || (typeof parsedInput?.description === 'string' ? parsedInput.description : '')
      || (typeof parsedInput?.prompt === 'string' ? parsedInput.prompt : '');
    const model = task.subagent?.model;

    const activityNodes: AgentTreeNode[] = activities.map((act, actIdx) => {
      const toolName = act.toolName || (act.kind === 'tool' ? 'Tool' : act.kind);
      const inputStr = typeof act.toolInput === 'string'
        ? act.toolInput
        : act.toolInput
          ? JSON.stringify(act.toolInput)
          : '';
      return {
        id: `sub-act-${subagentId}-${act.toolId ?? actIdx}`,
        type: 'activity',
        label: toolName,
        subtitle: inputStr ? inputStr.slice(0, 50) : undefined,
        status: act.toolResult?.isError ? 'failed' : 'completed',
        message: task,
        activity: act,
        depth: 2,
        children: [],
      };
    });

    childNodes.push({
      id: `sub-${subagentId}`,
      type: 'subagent',
      label: agentType,
      subtitle: description,
      status: taskStatus,
      model,
      durationMs,
      message: task,
      depth: 1,
      children: activityNodes,
    });
  });

  // Calculate overall root status
  let rootStatus: 'running' | 'completed' | 'failed' | 'stopped' = 'completed';
  if (childNodes.some((c) => c.status === 'running')) {
    rootStatus = 'running';
  } else if (childNodes.some((c) => c.status === 'failed')) {
    rootStatus = 'failed';
  } else if (childNodes.some((c) => c.status === 'stopped')) {
    rootStatus = 'stopped';
  }

  const rootNode: AgentTreeNode = {
    id: `root-${session.id}`,
    type: 'root',
    label: 'Main Agent',
    subtitle: session.title || 'Session Root',
    status: rootStatus,
    depth: 0,
    children: childNodes,
  };

  return [rootNode];
}

export function collectAllNodeIds(nodes: AgentTreeNode[]): string[] {
  const ids: string[] = [];
  function traverse(n: AgentTreeNode) {
    ids.push(n.id);
    n.children.forEach(traverse);
  }
  nodes.forEach(traverse);
  return ids;
}

export function findNodeInTree(nodes: AgentTreeNode[], id: string): AgentTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeInTree(node.children, id);
    if (found) return found;
  }
  return null;
}

export function countTreeStats(nodes: AgentTreeNode[]) {
  let totalTasks = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;
  let stopped = 0;
  let totalActivities = 0;

  function traverse(node: AgentTreeNode) {
    if (node.type === 'subagent' || node.type === 'workflow' || node.type === 'background_task') {
      totalTasks++;
      if (node.status === 'running') running++;
      else if (node.status === 'completed') completed++;
      else if (node.status === 'failed') failed++;
      else if (node.status === 'stopped') stopped++;
    } else if (node.type === 'activity') {
      totalActivities++;
    }
    node.children.forEach(traverse);
  }

  nodes.forEach(traverse);
  return { totalTasks, running, completed, failed, stopped, totalActivities };
}
