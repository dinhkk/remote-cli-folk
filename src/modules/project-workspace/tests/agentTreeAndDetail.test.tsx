import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, Project, ProjectSession } from '@/shared/types';
import { SubagentDetailView } from '@/modules/project-workspace/agents/SubagentDetailView';
import { buildAgentTree } from '@/modules/project-workspace/agents/agentTreeUtils';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, defaultValue?: string) => defaultValue || key,
    }),
  };
});

afterEach(cleanup);

const project: Project = { projectId: 'proj-1', name: 'test-project', displayName: 'Test Project', fullPath: '/path/to/test' };
const session: ProjectSession = { id: 'sess-1', projectId: 'proj-1', title: 'Test Session' };

const messages: ChatMessage[] = [
  { type: 'user', content: 'Refactor the backend and run tests', timestamp: 1000 },
  {
    type: 'tool_use',
    timestamp: 2000,
    toolName: 'Agent',
    toolId: 'tool-agent-1',
    toolInput: JSON.stringify({ prompt: 'Explore codebase architecture', subagent_type: 'architect' }),
    subagent: { id: 'subagent-1', type: 'architect', description: 'Explore codebase architecture', status: 'completed', model: 'claude-sonnet-5-5' },
    subagentActivity: [
      { kind: 'tool', toolName: 'Read', toolId: 'act-read-1', toolInput: '/src/index.ts', toolResult: { content: 'console.log("hello");', isError: false } },
      { kind: 'tool', toolName: 'Edit', toolId: 'act-edit-2', toolInput: { file_path: '/src/index.ts', new_string: 'export default {}' }, toolResult: { content: 'File edited successfully', isError: false } },
    ],
  },
  {
    type: 'tool_use',
    timestamp: 3000,
    toolName: 'Bash',
    toolId: 'tool-bash-1',
    toolInput: JSON.stringify({ command: 'npm test', description: 'Run test suite' }),
    taskStatus: { taskId: 'task-bash-1', status: 'running', usage: { totalTokens: 120, toolUses: 1, durationMs: 4200 } },
  },
];

describe('buildAgentTree', () => {
  it('builds Root (Main Agent) -> sub-agents / background tasks -> tool activities', () => {
    const tree = buildAgentTree(session, messages);

    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.type).toBe('root');
    expect(root.label).toBe('Main Agent');
    expect(root.subtitle).toBe('Test Session');
    // The running background task makes the root running.
    expect(root.status).toBe('running');

    expect(root.children).toHaveLength(2);
    const subagentNode = root.children[0];
    expect(subagentNode.type).toBe('subagent');
    expect(subagentNode.label).toBe('architect');
    expect(subagentNode.model).toBe('claude-sonnet-5-5');
    expect(subagentNode.status).toBe('completed');

    const bashNode = root.children[1];
    expect(bashNode.type).toBe('background_task');
    expect(bashNode.label).toBe('Run test suite');
    expect(bashNode.status).toBe('running');

    expect(subagentNode.children).toHaveLength(2);
    expect(subagentNode.children[0].type).toBe('activity');
    expect(subagentNode.children[0].label).toBe('Read');
    expect(subagentNode.children[1].label).toBe('Edit');
  });
});

describe('SubagentDetailView', () => {
  const props = { selectedProject: project, onFileOpen: vi.fn(), onJumpToChat: vi.fn(), onStopTask: vi.fn() };
  const nodes = () => {
    const subagentNode = buildAgentTree(session, messages)[0].children[0];
    return { subagentNode, activityNode: subagentNode.children[0] };
  };

  it('inspects a sub-agent: its type, prompt and recorded activities', () => {
    const { subagentNode } = nodes();
    render(<SubagentDetailView {...props} selectedNode={subagentNode} message={subagentNode.message} />);
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getAllByText('Explore codebase architecture').length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded Activities (2)')).toBeTruthy();
  });

  it('inspects one tool call: its input and output', () => {
    const { activityNode } = nodes();
    render(<SubagentDetailView {...props} selectedNode={activityNode} message={activityNode.message} />);
    expect(screen.getByText('Tool Execution Step')).toBeTruthy();
    expect(screen.getByText('Input Arguments')).toBeTruthy();
    expect(screen.getByText('/src/index.ts')).toBeTruthy();
    expect(screen.getByText(/console.log\("hello"\);/)).toBeTruthy();
  });

  it('has no overview of the whole session any more: that is the Monitoring pane', () => {
    const root = buildAgentTree(session, messages)[0];
    render(<SubagentDetailView {...props} selectedNode={root} message={null} />);
    expect(screen.queryByText('Total Spawned')).toBeNull();
  });
});
