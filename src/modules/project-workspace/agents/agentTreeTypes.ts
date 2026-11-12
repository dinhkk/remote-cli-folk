import type { BackgroundTaskStatus, ChatMessage, SubagentActivity, WorkflowAgentInfo } from '@/shared/types';

export type AgentTreeNodeType =
  | 'root'               // Main Agent / Session Root
  | 'subagent'           // Subagent (e.g. general-purpose, coder, architect)
  | 'workflow'           // Workflow run
  | 'workflow_agent'     // Individual agent within a workflow
  | 'background_task'    // Background Bash command
  | 'activity';          // Tool execution step (Read, Edit, Bash, etc.)

export type AgentTreeNode = {
  id: string;
  type: AgentTreeNodeType;
  label: string;
  subtitle?: string;
  status: BackgroundTaskStatus;
  model?: string;
  durationMs?: number;
  message?: ChatMessage;
  activity?: SubagentActivity;
  workflowAgent?: WorkflowAgentInfo;
  depth: number;
  children: AgentTreeNode[];
};
