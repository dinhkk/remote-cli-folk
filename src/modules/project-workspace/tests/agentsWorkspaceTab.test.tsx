import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

import type { ChatMessage, Project, ProjectSession } from '@/shared/types';
import { AgentsWorkspaceView } from '@/modules/project-workspace/agents/AgentsWorkspaceView';
import { SubagentTreeNode } from '@/modules/project-workspace/agents/SubagentTreeNode';
import { SubagentTreeList } from '@/modules/project-workspace/agents/SubagentTreeList';
import { SubagentDetailView } from '@/modules/project-workspace/agents/SubagentDetailView';
import { buildAgentTree, countTreeStats } from '@/modules/project-workspace/agents/agentTreeUtils';

// Mock react-i18next
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, defaultValue?: string) => defaultValue || key,
    }),
  };
});

const mockGetMessages = vi.fn();
const mockSessionStore = {
  getMessages: mockGetMessages,
} as any;

describe('Agents Workspace Tab & Tree Hierarchy (Phase 1)', () => {
  const dummyProject: Project = {
    projectId: 'proj-1',
    name: 'test-project',
    displayName: 'Test Project',
    fullPath: '/path/to/test',
  };

  const dummySession: ProjectSession = {
    id: 'sess-1',
    projectId: 'proj-1',
    title: 'Test Session',
  };

  const sampleMessages: ChatMessage[] = [
    {
      type: 'user',
      content: 'Refactor the backend and run tests',
      timestamp: 1000,
    },
    {
      type: 'tool_use',
      timestamp: 2000,
      toolName: 'Agent',
      toolId: 'tool-agent-1',
      toolInput: JSON.stringify({ prompt: 'Explore codebase architecture', subagent_type: 'architect' }),
      subagent: {
        id: 'subagent-1',
        type: 'architect',
        description: 'Explore codebase architecture',
        status: 'completed',
        model: 'claude-sonnet-5-5',
      },
      subagentActivity: [
        {
          kind: 'tool',
          toolName: 'Read',
          toolId: 'act-read-1',
          toolInput: '/src/index.ts',
          toolResult: { content: 'console.log("hello");', isError: false },
        },
        {
          kind: 'tool',
          toolName: 'Edit',
          toolId: 'act-edit-2',
          toolInput: { file_path: '/src/index.ts', new_string: 'export default {}' },
          toolResult: { content: 'File edited successfully', isError: false },
        },
      ],
    },
    {
      type: 'tool_use',
      timestamp: 3000,
      toolName: 'Bash',
      toolId: 'tool-bash-1',
      toolInput: JSON.stringify({ command: 'npm test', description: 'Run test suite' }),
      taskStatus: {
        taskId: 'task-bash-1',
        status: 'running',
        usage: { totalTokens: 120, toolUses: 1, durationMs: 4200 },
      },
    },
  ];

  it('renders no-session view when session is null', () => {
    render(
      <AgentsWorkspaceView
        selectedProject={dummyProject}
        selectedSession={null}
        setActiveTab={vi.fn()}
        sendMessage={vi.fn()}
        onFileOpen={vi.fn()}
        sessionStore={mockSessionStore}
      />
    );
    expect(screen.getByText('No session selected')).toBeTruthy();
  });

  it('renders empty tasks view when no subagents or tasks exist', () => {
    mockGetMessages.mockReturnValue([]);

    render(
      <AgentsWorkspaceView
        selectedProject={dummyProject}
        selectedSession={dummySession}
        setActiveTab={vi.fn()}
        sendMessage={vi.fn()}
        onFileOpen={vi.fn()}
        sessionStore={mockSessionStore}
      />
    );
    expect(screen.getByText('No Subagents or Background Tasks')).toBeTruthy();
  });

  it('buildAgentTree constructs a 3-tier tree: Root (Main Agent) -> Subagents -> Tool Activities', () => {
    const tree = buildAgentTree(dummySession, sampleMessages);

    // Root level (Main Agent)
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.type).toBe('root');
    expect(root.label).toBe('Main Agent');
    expect(root.subtitle).toBe('Test Session');
    // Root status is running because child bash task is running
    expect(root.status).toBe('running');

    // Level 2 (Subagent and Background Task)
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

    // Level 3 (Activities under subagent)
    expect(subagentNode.children).toHaveLength(2);
    expect(subagentNode.children[0].type).toBe('activity');
    expect(subagentNode.children[0].label).toBe('Read');
    expect(subagentNode.children[1].type).toBe('activity');
    expect(subagentNode.children[1].label).toBe('Edit');
  });

  it('renders SubagentTreeList with hierarchical tree nodes and toolbar controls', () => {
    const onSelectNode = vi.fn();
    const onJumpToChat = vi.fn();
    const onStopTask = vi.fn();

    const tree = buildAgentTree(dummySession, sampleMessages);

    render(
      <SubagentTreeList
        treeNodes={tree}
        session={dummySession}
        messages={sampleMessages}
        onSelectNode={onSelectNode}
        onJumpToChat={onJumpToChat}
        onStopTask={onStopTask}
      />
    );

    // Root Node
    expect(screen.getByText('Main Agent')).toBeTruthy();

    // Level 2 Nodes
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getByText('Run test suite')).toBeTruthy();

    // Level 3 Activities
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();

    // Clicking a node selects it
    fireEvent.click(screen.getByText('architect'));
    expect(onSelectNode).toHaveBeenCalled();
  });

  it('toggles collapse and expand on tree branches', () => {
    const tree = buildAgentTree(dummySession, sampleMessages);

    render(
      <SubagentTreeList
        treeNodes={tree}
        session={dummySession}
        messages={sampleMessages}
        onJumpToChat={vi.fn()}
        onStopTask={vi.fn()}
      />
    );

    // Initially child activities 'Read' and 'Edit' are visible
    expect(screen.getByText('Read')).toBeTruthy();

    // Click collapse button on architect node
    const collapseButtons = screen.getAllByRole('button', { name: /collapse/i });
    expect(collapseButtons.length).toBeGreaterThan(0);
    fireEvent.click(collapseButtons[1]); // collapse architect sub-branch

    // Child activities of architect are collapsed
    expect(screen.queryByText('Read')).toBeNull();

    // Click expand all in toolbar
    const expandAllBtn = screen.getByRole('button', { name: /expand all/i });
    fireEvent.click(expandAllBtn);
    expect(screen.getByText('Read')).toBeTruthy();
  });

  it('renders SubagentDetailView for Root Node, Activity Node, and Subagent Node', () => {
    const tree = buildAgentTree(dummySession, sampleMessages);
    const rootNode = tree[0];
    const subagentNode = rootNode.children[0];
    const activityNode = subagentNode.children[0];

    // 1. Root Node Inspector
    const { rerender } = render(
      <SubagentDetailView
        selectedNode={rootNode}
        selectedProject={dummyProject}
        selectedSession={dummySession}
        onFileOpen={vi.fn()}
        onJumpToChat={vi.fn()}
        onStopTask={vi.fn()}
      />
    );
    expect(screen.getByText('Total Spawned')).toBeTruthy();
    expect(screen.getByText('Spawned Tasks & Subagents (2)')).toBeTruthy();

    // 2. Subagent Node Inspector
    rerender(
      <SubagentDetailView
        selectedNode={subagentNode}
        message={subagentNode.message}
        selectedProject={dummyProject}
        selectedSession={dummySession}
        onFileOpen={vi.fn()}
        onJumpToChat={vi.fn()}
        onStopTask={vi.fn()}
      />
    );
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getAllByText('Explore codebase architecture').length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded Activities (2)')).toBeTruthy();

    // 3. Activity Node Inspector
    rerender(
      <SubagentDetailView
        selectedNode={activityNode}
        message={activityNode.message}
        selectedProject={dummyProject}
        selectedSession={dummySession}
        onFileOpen={vi.fn()}
        onJumpToChat={vi.fn()}
        onStopTask={vi.fn()}
      />
    );
    expect(screen.getByText('Tool Execution Step')).toBeTruthy();
    expect(screen.getByText('Input Arguments')).toBeTruthy();
    expect(screen.getByText('/src/index.ts')).toBeTruthy();
    expect(screen.getByText(/console.log\("hello"\);/)).toBeTruthy();
  });

  it('supports backward compatibility for standalone SubagentTreeNode', () => {
    const onSelect = vi.fn();
    const onJumpToChat = vi.fn();
    const onStopTask = vi.fn();

    render(
      <SubagentTreeNode
        message={sampleMessages[1]}
        isSelected={false}
        onSelect={onSelect}
        onJumpToChat={onJumpToChat}
        onStopTask={onStopTask}
      />
    );

    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-5-5')).toBeTruthy();

    fireEvent.click(screen.getByText('architect'));
    expect(onSelect).toHaveBeenCalledWith(sampleMessages[1]);
  });
});
