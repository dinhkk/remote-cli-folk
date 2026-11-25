import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import type { RunningActivityContext } from '@/modules/agent-monitor';
import type { SessionStore } from '@/modules/chat';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';
import { AgentActivityPanel } from '@/modules/project-workspace/agents/AgentActivityPanel';

// The store hands out normalized rows; this test feeds chat messages straight through (as a new array, like the real conversion).
vi.mock('@/modules/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/chat')>()),
  normalizedToChatMessages: (rows: unknown[]) => [...rows],
}));

const scrollToToolResult = vi.hoisted(() => vi.fn());
vi.mock('@/modules/project-workspace/agents/scrollToToolResult', () => ({ scrollToToolResult }));

afterEach(cleanup);

const project: Project = { projectId: 'proj-1', name: 'test-project', displayName: 'Test Project', fullPath: '/path/to/test' };
const session: ProjectSession = { id: 'chat-1', title: 'Test Session' };

const subagentTask = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'tool_use',
  timestamp: 2000,
  toolName: 'Agent',
  toolId: 'toolu_a',
  toolInput: JSON.stringify({ prompt: 'Explore codebase architecture', subagent_type: 'architect' }),
  subagent: { id: 'agent-aaa', type: 'architect', description: 'Explore codebase architecture', status: 'completed', model: 'claude-sonnet-5-5' },
  subagentActivity: [
    { kind: 'tool', toolName: 'Read', toolId: 'act-1', toolInput: '/src/index.ts', toolResult: { content: 'console.log("hello");', isError: false } },
    { kind: 'tool', toolName: 'Edit', toolId: 'act-2', toolInput: { file_path: '/src/index.ts', new_string: 'x' }, toolResult: { content: 'edited', isError: false } },
  ],
  ...overrides,
});

const runningTask = (): ChatMessage => subagentTask({
  toolId: 'toolu_run',
  subagent: { id: 'agent-run', type: 'coder', status: 'running' },
  taskStatus: { taskId: 'task-run', status: 'running', usage: { totalTokens: 10, toolUses: 1, durationMs: 100 } },
});

const makeStore = (rows: unknown[], fetchStatus: 'idle' | 'error' = 'idle') => ({
  getMessages: vi.fn(() => rows),
  getSessionSlot: vi.fn(() => ({ status: fetchStatus })),
  fetchFromServer: vi.fn(async () => ({ status: fetchStatus })),
  refreshLatestFromServer: vi.fn(async () => ({ changed: false })),
}) as unknown as SessionStore & { fetchFromServer: ReturnType<typeof vi.fn> };

type Overrides = Partial<{ agentId: string; running: boolean; chatId: string }>;

const mount = (store: SessionStore, overrides: Overrides = {}) => {
  const openChat = vi.fn();
  const sendMessage = vi.fn();
  const setActiveTab = vi.fn();
  const onFileOpen = vi.fn();
  const context: RunningActivityContext = { sessionKey: 's1', chatId: overrides.chatId ?? 'chat-1', agentId: overrides.agentId ?? 'toolu_a', running: overrides.running ?? false, openChat, fill: false };
  render(
    <AgentActivityPanel
      context={context}
      sessionStore={store}
      selectedProject={project}
      selectedSession={session}
      sendMessage={sendMessage}
      setActiveTab={setActiveTab}
      onFileOpen={onFileOpen}
    />,
  );
  return { openChat, sendMessage, setActiveTab, onFileOpen };
};

describe('AgentActivityPanel', () => {
  it('draws the inspector of the sub-agent the monitor box names: its type, prompt and recorded tool calls', () => {
    mount(makeStore([subagentTask()]));
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getAllByText('Explore codebase architecture').length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded Activities (2)')).toBeTruthy();
  });

  it('loads the history of a chat the store does not hold, saying so meanwhile', async () => {
    const rows: unknown[] = [];
    const store = makeStore(rows);
    (store.fetchFromServer as ReturnType<typeof vi.fn>).mockImplementation(async () => { rows.push(subagentTask()); return { status: 'idle' }; });
    mount(store);
    expect(screen.getByText('Loading the agent\'s activity…')).toBeTruthy();
    await screen.findByText('Recorded Activities (2)');
    expect(store.fetchFromServer).toHaveBeenCalledWith('chat-1');
  });

  it('says there is no recorded activity when the history has no such agent', () => {
    mount(makeStore([subagentTask()]), { agentId: 'toolu_missing' });
    expect(screen.getByText('No recorded activity for this agent.')).toBeTruthy();
  });

  it('says the load failed when the history cannot be fetched', async () => {
    mount(makeStore([], 'error'));
    await screen.findByText('Could not load the agent\'s activity.');
  });

  it('stops the task of a running agent in the chat that owns it', () => {
    const { sendMessage } = mount(makeStore([runningTask()]), { agentId: 'toolu_run', running: true });
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'chat-1', taskId: 'task-run' });
  });

  it('opens the chat, shows the chat tab and scrolls to the agent\'s tool result on "View in Chat"', () => {
    const { openChat, setActiveTab } = mount(makeStore([subagentTask()]));
    fireEvent.click(screen.getByRole('button', { name: /view in chat/i }));
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(setActiveTab).toHaveBeenCalledWith('chat');
    expect(scrollToToolResult).toHaveBeenCalledWith('toolu_a');
  });
});
