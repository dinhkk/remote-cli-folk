import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

describe('Mobile Scroll Anchoring & Touch Lifecycle (Phase 3)', () => {
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
      content: 'Hello, this is a test user message',
      timestamp: Date.now() - 5000,
    },
    {
      type: 'assistant',
      content: 'Hello, this is a test assistant response',
      timestamp: Date.now(),
    },
  ];

  it('renders chat-messages-pane with native overflow-anchor: auto and overscroll-behavior-y: contain', () => {
    const scrollContainerRef = React.createRef<HTMLDivElement>();
    const onTouchStart = vi.fn();
    const onTouchEnd = vi.fn();

    const { container } = render(
      <UiPreferencesProvider>
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={vi.fn()}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          isLoadingSessionMessages={false}
          chatMessages={sampleMessages}
          selectedSession={dummySession}
          currentSessionId="sess-1"
          provider="claude"
          setProvider={vi.fn()}
          textareaRef={React.createRef<HTMLTextAreaElement>()}
          providerModels={{ claude: 'claude-sonnet-5-5' } as any}
          setProviderModel={vi.fn()}
          providerModelCatalog={{} as any}
          providerModelActions={{} as any}
          providerModelsLoading={false}
          tasksEnabled={false}
          isTaskMasterInstalled={false}
          setInput={vi.fn()}
          isLoadingMoreMessages={false}
          hasMoreMessages={true}
          totalMessages={10}
          sessionMessagesCount={2}
          visibleMessageCount={2}
          visibleMessages={sampleMessages}
          loadEarlierMessages={vi.fn()}
          revealMessage={vi.fn()}
          backgroundTasks={[]}
          sendMessage={vi.fn()}
          loadAllMessages={vi.fn()}
          allMessagesLoaded={false}
          isLoadingAllMessages={false}
          loadAllJustFinished={false}
          showLoadAllOverlay={false}
          createDiff={() => []}
          onGrantToolPermission={vi.fn()}
          selectedProject={dummyProject}
        />
      </UiPreferencesProvider>
    );

    const pane = container.querySelector('.chat-messages-pane') as HTMLDivElement;
    expect(pane).toBeTruthy();
    expect(pane.style.overflowAnchor).toBe('auto');
    expect(pane.style.overscrollBehaviorY).toBe('contain');
  });

  it('sets overflow-anchor: none on the loading indicator to prevent layout jitter', () => {
    const scrollContainerRef = React.createRef<HTMLDivElement>();

    const { container } = render(
      <UiPreferencesProvider>
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={vi.fn()}
          isLoadingSessionMessages={false}
          chatMessages={sampleMessages}
          selectedSession={dummySession}
          currentSessionId="sess-1"
          provider="claude"
          setProvider={vi.fn()}
          textareaRef={React.createRef<HTMLTextAreaElement>()}
          providerModels={{ claude: 'claude-sonnet-5-5' } as any}
          setProviderModel={vi.fn()}
          providerModelCatalog={{} as any}
          providerModelActions={{} as any}
          providerModelsLoading={false}
          tasksEnabled={false}
          isTaskMasterInstalled={false}
          setInput={vi.fn()}
          isLoadingMoreMessages={true}
          hasMoreMessages={true}
          totalMessages={10}
          sessionMessagesCount={2}
          visibleMessageCount={2}
          visibleMessages={sampleMessages}
          loadEarlierMessages={vi.fn()}
          revealMessage={vi.fn()}
          backgroundTasks={[]}
          sendMessage={vi.fn()}
          loadAllMessages={vi.fn()}
          allMessagesLoaded={false}
          isLoadingAllMessages={false}
          loadAllJustFinished={false}
          showLoadAllOverlay={false}
          createDiff={() => []}
          onGrantToolPermission={vi.fn()}
          selectedProject={dummyProject}
        />
      </UiPreferencesProvider>
    );

    // Find the loading indicator container
    const loadingElem = container.querySelector('div[style*="overflow-anchor: none"]');
    expect(loadingElem).toBeTruthy();
  });
});
