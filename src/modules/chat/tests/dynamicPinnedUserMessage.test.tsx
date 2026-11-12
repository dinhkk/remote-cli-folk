import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

import DynamicPinnedUserMessage from '@/modules/chat/transcript/DynamicPinnedUserMessage';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

describe('Dynamic Pinned User Message (Requirement 4)', () => {
  const dummyUserMessage: ChatMessage = {
    type: 'user',
    content: 'Please refactor the authentication middleware to use JWT and verify tests.',
    timestamp: 1700000000000,
  };

  it('renders nothing when message is null or not a user message', () => {
    const onJumpToMessage = vi.fn();
    const { container: nullContainer } = render(
      <DynamicPinnedUserMessage message={null} onJumpToMessage={onJumpToMessage} />
    );
    expect(nullContainer.firstChild).toBeNull();

    const assistantMsg: ChatMessage = {
      type: 'assistant',
      content: 'Sure, I will do that.',
      timestamp: 1700000001000,
    };
    const { container: assistantContainer } = render(
      <DynamicPinnedUserMessage message={assistantMsg} onJumpToMessage={onJumpToMessage} />
    );
    expect(assistantContainer.firstChild).toBeNull();
  });

  it('renders pinned user message with truncated preview', () => {
    const onJumpToMessage = vi.fn();
    render(
      <DynamicPinnedUserMessage
        message={dummyUserMessage}
        isProcessing={false}
        onJumpToMessage={onJumpToMessage}
      />
    );

    expect(screen.getByText(/Please refactor the authentication middleware/i)).toBeTruthy();
  });

  it('shows processing indicator when isProcessing is true', () => {
    const onJumpToMessage = vi.fn();
    render(
      <DynamicPinnedUserMessage
        message={dummyUserMessage}
        isProcessing={true}
        onJumpToMessage={onJumpToMessage}
      />
    );

    expect(screen.getByText(/Processing.../i)).toBeTruthy();
  });

  it('toggles expansion state when chevron button is clicked', () => {
    const onJumpToMessage = vi.fn();
    const { getByRole, getByText } = render(
      <DynamicPinnedUserMessage
        message={dummyUserMessage}
        onJumpToMessage={onJumpToMessage}
      />
    );

    const contentDiv = getByText(/Please refactor the authentication middleware/i);
    expect(contentDiv.className).toContain('truncate');

    const expandButton = getByRole('button', { name: /expand/i });
    fireEvent.click(expandButton);

    const expandedContent = getByText(/Please refactor the authentication middleware/i);
    expect(expandedContent.className).toContain('whitespace-pre-wrap');
  });

  it('invokes onJumpToMessage when clicked', () => {
    const onJumpToMessage = vi.fn();
    const { getByText } = render(
      <DynamicPinnedUserMessage
        message={dummyUserMessage}
        onJumpToMessage={onJumpToMessage}
      />
    );

    fireEvent.click(getByText(/Please refactor the authentication middleware/i));
    expect(onJumpToMessage).toHaveBeenCalledWith(dummyUserMessage);
  });

  it('renders within ChatMessagesPane and pins the latest user prompt', () => {
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

    const messages: ChatMessage[] = [
      {
        type: 'user',
        content: 'First question from user',
        timestamp: 1000,
      },
      {
        type: 'assistant',
        content: 'First answer from assistant',
        timestamp: 2000,
      },
      {
        type: 'user',
        content: 'Second question that should be pinned',
        timestamp: 3000,
      },
      {
        type: 'assistant',
        content: 'Second answer',
        timestamp: 4000,
      },
    ];

    const scrollContainerRef = React.createRef<HTMLDivElement>();

    const { getByText, getByRole } = render(
      <UiPreferencesProvider>
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={vi.fn()}
          isLoadingSessionMessages={false}
          chatMessages={messages}
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
          hasMoreMessages={false}
          totalMessages={4}
          sessionMessagesCount={4}
          visibleMessageCount={4}
          visibleMessages={messages}
          loadEarlierMessages={vi.fn()}
          revealMessage={vi.fn()}
          backgroundTasks={[]}
          sendMessage={vi.fn()}
          loadAllMessages={vi.fn()}
          allMessagesLoaded={true}
          isLoadingAllMessages={false}
          loadAllJustFinished={false}
          showLoadAllOverlay={false}
          createDiff={() => []}
          onGrantToolPermission={vi.fn()}
          selectedProject={dummyProject}
        />
      </UiPreferencesProvider>
    );

    const pinnedRegion = getByRole('region', { name: /pinned user message/i });
    expect(pinnedRegion).toBeTruthy();
    expect(within(pinnedRegion).getByText(/Second question that should be pinned/i)).toBeTruthy();
  });

  describe('Mobile Pinned User Message (Translucent bubble and collapsible circular bubble)', () => {
    it('renders as a translucent bubble card on mobile', () => {
      const onJumpToMessage = vi.fn();
      render(
        <DynamicPinnedUserMessage
          message={dummyUserMessage}
          isProcessing={false}
          onJumpToMessage={onJumpToMessage}
          isMobile={true}
        />
      );

      expect(screen.getByText(/Please refactor the authentication middleware/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /full width/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /collapse to bubble/i })).toBeTruthy();
    });

    it('collapses into circular bubble on the right when collapse button is clicked, and expands back when clicked', () => {
      const onJumpToMessage = vi.fn();
      render(
        <DynamicPinnedUserMessage
          message={dummyUserMessage}
          isProcessing={true}
          onJumpToMessage={onJumpToMessage}
          isMobile={true}
        />
      );

      // Initially in bubble card mode
      const collapseBtn = screen.getByRole('button', { name: /collapse to bubble/i });
      fireEvent.click(collapseBtn);

      // Now collapsed into circular bubble button
      const circularBtn = screen.getByRole('button', { name: /open active prompt/i });
      expect(circularBtn).toBeTruthy();
      // Text prompt is hidden in collapsed circle mode
      expect(screen.queryByText(/Please refactor the authentication middleware/i)).toBeNull();

      // Click circular button to expand back
      fireEvent.click(circularBtn);

      // Prompt is visible again
      expect(screen.getByText(/Please refactor the authentication middleware/i)).toBeTruthy();
    });

    it('toggles full width expanded view on mobile', () => {
      const onJumpToMessage = vi.fn();
      const { getByRole, getByText } = render(
        <DynamicPinnedUserMessage
          message={dummyUserMessage}
          onJumpToMessage={onJumpToMessage}
          isMobile={true}
        />
      );

      const contentDiv = getByText(/Please refactor the authentication middleware/i);
      expect(contentDiv.className).toContain('truncate');

      const fullWidthBtn = getByRole('button', { name: /full width/i });
      fireEvent.click(fullWidthBtn);

      const expandedContent = getByText(/Please refactor the authentication middleware/i);
      expect(expandedContent.className).toContain('whitespace-pre-wrap');

      // Toggles back
      const collapseBtn = getByRole('button', { name: /^collapse$/i });
      fireEvent.click(collapseBtn);
      expect(getByText(/Please refactor the authentication middleware/i).className).toContain('truncate');
    });
  });
});
