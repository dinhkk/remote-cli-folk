import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type {
  ChatMessage,
  NewChatScopeRequest,
  PermissionMode,
  Project,
  SessionEstablishedContext,
} from '@/shared/types';

/**
 * The first message of a brand-new chat creates its session with `POST /api/providers/sessions`. With a main agent
 * chosen the body carries `scope: { agentName }`; a chat without picker state must leave the key out entirely (the
 * server answers 400 to `scope: null`). A failed scoped create shows the server's reason, and the session is always
 * filed under the sidebar project (the folder it runs in is the one sent as `projectPath`).
 */

const SIDEBAR_PROJECT: Project = { projectId: 'project-1', displayName: 'Sidebar', fullPath: '/work/sidebar' };

type Created = { body: Record<string, unknown> };

let created: Created[];
let detailsCalls: string[];
let createReply: () => Response;
let detailsReply: () => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  created = [];
  detailsCalls = [];
  createReply = () => json({ success: true, data: { sessionId: 'session-1', sessionName: 'hello', projectPath: '/work/sidebar' } }, 201);
  detailsReply = () => json({ success: true, data: { project: null } });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/providers/sessions' && init?.method === 'POST') {
      created.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return createReply();
    }
    if (path.startsWith('/api/providers/sessions/') && (init?.method ?? 'GET') === 'GET') {
      detailsCalls.push(path);
      return detailsReply();
    }
    return json([]);
  }));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderComposer = (newChatScope?: NewChatScopeRequest) => {
  const sent: Array<{ type: string; sessionId?: string }> = [];
  const errors: string[] = [];
  const established: Array<{ sessionId: string; context: SessionEstablishedContext }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: SIDEBAR_PROJECT,
      selectedSession: null,
      currentSessionId: null,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      onSessionEstablished: (sessionId, context) => { established.push({ sessionId, context }); },
      newChatScope,
      scrollToBottom: () => undefined,
      addMessage: (message: ChatMessage) => { if (message.type === 'error') errors.push(String(message.content)); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  const send = async (text = 'hello') => {
    await act(async () => { view.result.current.setInput(text); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  };
  return { send, sent, errors, established };
};

test('a plain chat creates its session without any scope key', async () => {
  const { send, sent } = renderComposer({});
  await send();

  assert.equal(created.length, 1);
  assert.equal('scope' in created[0].body, false, 'no scope key at all (null would be a 400)');
  assert.equal(created[0].body.projectPath, '/work/sidebar');
  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 1);
});

test('a chat without any picker state behaves as before (no scope key)', async () => {
  const { send } = renderComposer(undefined);
  await send();
  assert.equal('scope' in created[0].body, false);
});

test('a main agent is sent with the session creation, the sidebar path being the folder the chat runs in', async () => {
  const { send } = renderComposer({ scope: { agentName: 'orchestrator' } });
  await send();

  assert.deepEqual(created[0].body.scope, { agentName: 'orchestrator' });
  assert.equal(created[0].body.projectPath, '/work/sidebar');
});

test('"no main agent" is sent as agentName null inside the scope (a scoped chat: hidden agents stay hidden)', async () => {
  const { send } = renderComposer({ scope: { agentName: null } });
  await send();

  assert.deepEqual(created[0].body.scope, { agentName: null });
});

test('a scoped create the server refuses shows the server\'s reason; a plain one keeps the short status text', async () => {
  createReply = () => json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'Agent "orchestrator" was not found in the project\'s .claude/agents or in ~/.claude/agents.' } }, 404);
  const scoped = renderComposer({ scope: { agentName: 'orchestrator' } });
  await scoped.send();
  assert.deepEqual(scoped.errors, ['Failed to start a new session: Agent "orchestrator" was not found in the project\'s .claude/agents or in ~/.claude/agents.']);
  assert.equal(scoped.sent.length, 0);

  const plain = renderComposer({});
  await plain.send();
  assert.deepEqual(plain.errors, ['Failed to start a new session: Failed to create session (404)']);
});

test('a scoped session is filed under the sidebar project, with no owner lookup (it always runs in that project\'s folder)', async () => {
  const { send, established, sent } = renderComposer({ scope: { agentName: 'orchestrator' } });
  await send();

  assert.deepEqual(detailsCalls, []);
  assert.equal(established.length, 1);
  assert.equal(established[0].context.project.projectId, 'project-1');
  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 1);
});
