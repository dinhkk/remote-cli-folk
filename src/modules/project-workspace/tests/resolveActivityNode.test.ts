import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import { resolveActivityNode } from '@/modules/project-workspace/agents/resolveActivityNode';

const subagentTask = (toolId: string, agentId: string, type = 'architect'): ChatMessage => ({
  type: 'tool_use',
  timestamp: 2000,
  toolName: 'Agent',
  toolId,
  toolInput: JSON.stringify({ prompt: 'Explore', subagent_type: type }),
  subagent: { id: agentId, type, description: 'Explore', status: 'completed', model: 'claude-sonnet-5-5' },
  subagentActivity: [{ kind: 'tool', toolName: 'Read', toolId: `${toolId}-read`, toolInput: '/a.ts', toolResult: { content: 'x', isError: false } }],
});

const workflowTask = (toolId: string): ChatMessage => ({
  type: 'tool_use',
  timestamp: 2500,
  toolName: 'Workflow',
  toolId,
  workflow: { runId: 'run-1', name: 'Release', status: 'running', agents: [], agentCounts: { total: 0, completed: 0, failed: 0, running: 0, stopped: 0 } },
});

const backgroundBash = (toolId: string): ChatMessage => ({
  type: 'tool_use',
  timestamp: 3000,
  toolName: 'Bash',
  toolId,
  toolInput: JSON.stringify({ command: 'npm test', description: 'Run tests' }),
  taskStatus: { taskId: 'task-bash-1', status: 'running', usage: { totalTokens: 1, toolUses: 1, durationMs: 10 } },
});

const messages: ChatMessage[] = [
  { type: 'user', content: 'go', timestamp: 1000 },
  subagentTask('toolu_a', 'agent-aaa'),
  subagentTask('toolu_b', 'agent-bbb', 'coder'),
  workflowTask('toolu_wf'),
  backgroundBash('toolu_bash'),
];

describe('resolveActivityNode', () => {
  it('finds a sub-agent by the tool call that launched it', () => {
    const node = resolveActivityNode('sess-1', messages, 'toolu_b');
    expect(node?.type).toBe('subagent');
    expect(node?.label).toBe('coder');
    expect(node?.message?.toolId).toBe('toolu_b');
  });

  it('picks the right task when several share a type', () => {
    const first = resolveActivityNode('sess-1', messages, 'toolu_a');
    const second = resolveActivityNode('sess-1', messages, 'toolu_b');
    expect(first?.message?.toolId).toBe('toolu_a');
    expect(second?.message?.toolId).toBe('toolu_b');
  });

  it('also matches the agent id, which the monitor falls back to when a transcript names no tool call', () => {
    expect(resolveActivityNode('sess-1', messages, 'agent-aaa')?.message?.toolId).toBe('toolu_a');
  });

  it('finds a workflow and a background command by their tool call', () => {
    expect(resolveActivityNode('sess-1', messages, 'toolu_wf')?.type).toBe('workflow');
    expect(resolveActivityNode('sess-1', messages, 'toolu_bash')?.type).toBe('background_task');
  });

  it('returns the launch node, never one of its tool activities', () => {
    expect(resolveActivityNode('sess-1', messages, 'toolu_a-read')).toBeNull();
  });

  it('returns null when nothing matches, the history is not loaded, or the id is empty', () => {
    expect(resolveActivityNode('sess-1', messages, 'toolu_missing')).toBeNull();
    expect(resolveActivityNode('sess-1', [], 'toolu_a')).toBeNull();
    expect(resolveActivityNode('sess-1', messages, '')).toBeNull();
  });
});
