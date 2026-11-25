import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * ChatInterface is where the main agent reaches the composer: a brand-new Claude chat hands the composer the main-agent
 * menu state for the project open in the sidebar plus its request (default = Auto, no main agent), an open session shows
 * the read-only badge instead, and a chat of another provider gets neither (the server refuses scopes for them).
 * Everything around ChatInterface is stubbed (the composer only records its props); the badge and the requests are real.
 */

const harness = vi.hoisted(() => ({
  provider: 'claude',
  sessionId: null as string | null,
  composerArgs: [] as Array<{ newChatScope?: unknown; onShowSettings?: unknown }>,
  composerProps: [] as Array<{ agentScope?: unknown }>,
  requests: [] as string[],
  sessionScope: null as unknown,
  agents: [] as unknown[],
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: async () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: () => {},
    markSessionIdle: () => {},
    markSessionBackground: () => {},
    getSessionActivity: () => null,
  }),
}));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: harness.provider, pendingPermissionRequests: [] }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    currentSessionId: harness.sessionId,
    setCurrentSessionId: () => {},
    requestLatestMessages: async () => {},
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: (args: { newChatScope?: unknown; onShowSettings?: unknown }) => {
    harness.composerArgs.push(args);
    return { input: '', setInput: () => {}, textareaRef: { current: null } };
  },
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({
  default: (props: { agentScope?: unknown }) => {
    harness.composerProps.push(props);
    return null;
  },
}));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  harness.provider = 'claude';
  harness.sessionId = null;
  harness.composerArgs = [];
  harness.composerProps = [];
  harness.requests = [];
  harness.sessionScope = null;
  harness.agents = [
    { name: 'orchestrator', source: 'project', isOrchestrator: true },
    { name: 'review-code', source: 'project', isOrchestrator: false },
  ];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    harness.requests.push(href);
    const path = href.split('?')[0];
    if (path === '/api/agent-profiles/scope-options') {
      return json({ agents: harness.agents });
    }
    if (path === '/api/providers/sessions/s1') {
      return json({ success: true, data: { sessionId: 's1', agentScope: harness.sessionScope } });
    }
    return json({});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const project = (fullPath: string): Project => ({ projectId: 'p1', displayName: 'repo', fullPath, path: fullPath });
const session: ProjectSession = { id: 's1', provider: 'claude' };

const lastScopeRequest = () => harness.composerArgs.at(-1)?.newChatScope;
type AgentScopeProp = { status: string; agentName: string | null; agents: unknown[]; setAgentName: (name: string | null) => void } | null;
/** What ChatInterface hands the composer for the main-agent menu on its last render. */
const lastAgentScope = () => harness.composerProps.at(-1)?.agentScope as AgentScopeProp | undefined;

test('a new Claude chat hands the composer the main-agent menu state for the open project and its scope (Auto by default)', async () => {
  render(<ChatInterface isActive selectedProject={project('/work/alpha')} selectedSession={null} ws={null} sendMessage={() => {}} />);

  await waitFor(() => assert.equal(lastAgentScope()?.status, 'ready'));
  assert.equal(lastAgentScope()?.agentName, null);
  assert.equal(lastAgentScope()?.agents.length, 2);
  assert.deepEqual(harness.requests, ['/api/agent-profiles/scope-options?projectId=p1'], 'the agents of the open project, by its database id');
  await waitFor(() => assert.deepEqual(lastScopeRequest(), { scope: { agentName: null } }));
  assert.equal(screen.queryByTitle(/Chosen when this chat was opened/), null, 'no badge on a new chat');
});

test('picking the orchestrator puts its name into the scope the composer sends', async () => {
  render(<ChatInterface isActive selectedProject={project('/work/alpha')} selectedSession={null} ws={null} sendMessage={() => {}} />);

  await waitFor(() => assert.equal(lastAgentScope()?.status, 'ready'));
  act(() => lastAgentScope()?.setAgentName('orchestrator'));
  await waitFor(() => assert.deepEqual(lastScopeRequest(), { scope: { agentName: 'orchestrator' } }));
  assert.equal(lastAgentScope()?.agentName, 'orchestrator');
});

test('a project without agents hands the composer an empty menu and no setup hint: there is nothing to choose', async () => {
  harness.agents = [];
  render(<ChatInterface isActive selectedProject={project('/work/alpha')} selectedSession={null} ws={null} sendMessage={() => {}} onShowSettings={() => {}} />);

  await waitFor(() => assert.deepEqual(lastScopeRequest(), { scope: { agentName: null } }));
  assert.equal(lastAgentScope()?.agents.length, 0);
  assert.equal(screen.queryByRole('button'), null);
});

test('an open session shows the read-only main-agent badge and gives the composer no menu', async () => {
  harness.sessionId = 's1';
  harness.sessionScope = { agentName: 'orchestrator' };
  render(<ChatInterface isActive selectedProject={project('/work/alpha')} selectedSession={session} ws={null} sendMessage={() => {}} />);

  await screen.findByText('Main agent: orchestrator');
  assert.equal(lastAgentScope(), null);
  assert.deepEqual(harness.requests, ['/api/providers/sessions/s1'], 'the badge reads the session only');
});

test('a chat of another provider gets neither the menu nor a scope request, and an old plain session shows no badge', async () => {
  harness.provider = 'codex';
  const first = render(<ChatInterface isActive selectedProject={project('/work/alpha')} selectedSession={null} ws={null} sendMessage={() => {}} />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.notEqual(lastAgentScope()?.status, 'ready');
  assert.deepEqual(lastScopeRequest(), {});
  assert.deepEqual(harness.requests, [], 'no agent-profile request for a provider without scopes');
  first.unmount();

  harness.provider = 'claude';
  harness.sessionId = 's1';
  harness.sessionScope = null;
  render(<ChatInterface isActive selectedProject={project('/work/alpha')} selectedSession={session} ws={null} sendMessage={() => {}} />);
  await waitFor(() => assert.ok(harness.requests.includes('/api/providers/sessions/s1')));
  assert.equal(screen.queryByTitle(/Chosen when this chat was opened/), null);
});
