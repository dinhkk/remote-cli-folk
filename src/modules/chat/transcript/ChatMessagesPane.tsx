import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { BackgroundTaskSummary,
  ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import DynamicPinnedUserMessage from '@/modules/chat/transcript/DynamicPinnedUserMessage';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

type ChatMessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove?: () => void;
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  revealMessage: (message: ChatMessage) => void;
  /** The session's running background tasks from the activity map, for the strip to list ones whose rows are not loaded. */
  backgroundTasks?: BackgroundTaskSummary[];
  /** The chat websocket's send, which the background-tasks strip stops a task over. */
  sendMessage: (message: unknown) => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/**
 * Keys for the rows inside a collapsed tool group. They only have to be unique
 * among that group's own rows (ToolGroupContainer disambiguates repeats), so
 * they do not depend on the pane's per-render key map — and being a module
 * function, the prop keeps its identity, which is what lets
 * memo(ToolGroupContainer) skip a group on a stream tick that did not touch it.
 */
const getGroupedMessageKey = (message: ChatMessage): string =>
  getIntrinsicMessageKey(message) ?? 'message-generated';

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  onTouchStart,
  onTouchEnd,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  revealMessage,
  backgroundTasks,
  sendMessage,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onEditMessage,
  onForkFromMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // Stable key representing user messages so streaming deltas from assistant do not re-create userMessages
  const userMessagesSignature = useMemo(() => {
    let sig = '';
    for (const m of chatMessages) {
      if (m.type === 'user' && Boolean(m.content?.trim())) {
        sig += `${m.timestamp}:${m.content?.length};`;
      }
    }
    return sig;
  }, [chatMessages]);

  const userMessages = useMemo(() => {
    return chatMessages.filter((m) => m.type === 'user' && Boolean(m.content?.trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMessagesSignature]);

  const [activeUserMessage, setActiveUserMessage] = useState<ChatMessage | null>(null);

  // Sync latest user message when messages change and user is at/near bottom, or on initial load
  useEffect(() => {
    if (userMessages.length === 0) {
      setActiveUserMessage(null);
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      setActiveUserMessage(userMessages[userMessages.length - 1] ?? null);
      return;
    }
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    if (isNearBottom) {
      setActiveUserMessage(userMessages[userMessages.length - 1] ?? null);
    }
  }, [userMessages, scrollContainerRef]);

  // Track active user message on scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || userMessages.length === 0) return;

    let rafId: number | null = null;
    const updateActiveTurn = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // If near bottom, pin the latest user message
      if (scrollHeight - scrollTop - clientHeight < 150) {
        setActiveUserMessage(userMessages[userMessages.length - 1] ?? null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const userElements = Array.from(
        container.querySelectorAll<HTMLElement>('.chat-message.user')
      );

      if (userElements.length === 0) {
        return;
      }

      let matchedTimestamp: string | null = null;
      for (const el of userElements) {
        const rect = el.getBoundingClientRect();
        if (rect.top - containerRect.top <= 160) {
          matchedTimestamp = el.getAttribute('data-message-timestamp');
        } else {
          break;
        }
      }

      if (!matchedTimestamp) {
        matchedTimestamp = userElements[0]?.getAttribute('data-message-timestamp') ?? null;
      }

      if (matchedTimestamp) {
        const found = userMessages.find((m) => String(m.timestamp) === matchedTimestamp);
        if (found) {
          setActiveUserMessage(found);
        }
      }
    };

    const handleScroll = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateActiveTurn);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [scrollContainerRef, userMessages]);

  const handleJumpToUserMessage = useCallback((msg: ChatMessage) => {
    revealMessage(msg);
    const container = scrollContainerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(
      `[data-message-timestamp="${msg.timestamp}"]`
    );
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('ring-2', 'ring-purple-500/50', 'rounded-lg', 'transition-all');
      setTimeout(() => {
        target.classList.remove('ring-2', 'ring-purple-500/50', 'rounded-lg');
      }, 1500);
    }
  }, [scrollContainerRef, revealMessage]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      style={{ overflowAnchor: 'auto', overscrollBehaviorY: 'contain' }}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {activeUserMessage ? (
        <DynamicPinnedUserMessage
          message={activeUserMessage}
          isProcessing={isProcessing}
          onJumpToMessage={handleJumpToUserMessage}
          actions={
            chatMessages.length > 0 ? (
              <ChatExportMenu
                messages={chatMessages}
                sessionTitle={selectedSession?.summary || selectedSession?.title}
                provider={provider}
                selectedProject={selectedProject}
                createDiff={createDiff}
                onLoadFullTranscript={onLoadFullTranscript}
              />
            ) : null
          }
        />
      ) : chatMessages.length > 0 ? (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex items-start justify-end gap-2 sm:px-4">
          <div className="pointer-events-auto">
            <ChatExportMenu
              messages={chatMessages}
              sessionTitle={selectedSession?.summary || selectedSession?.title}
              provider={provider}
              selectedProject={selectedProject}
              createDiff={createDiff}
              onLoadFullTranscript={onLoadFullTranscript}
            />
          </div>
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 pt-3 sm:space-y-4 sm:pt-4">
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div style={{ overflowAnchor: 'none' }} className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div style={{ overflowAnchor: 'none' }} className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          <div style={{ overflowAnchor: 'none' }}>
            <LoadAllMessagesOverlay
              showLoadAllOverlay={showLoadAllOverlay}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              totalMessages={totalMessages}
              onLoadAllMessages={loadAllMessages}
            />
          </div>

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            const rowCount = groupedVisibleMessages.length;

            return groupedVisibleMessages.map((item, index) => {
              // Rows near the tail mount their content on first commit so the
              // initial scroll-to-bottom measures real heights; older rows
              // start as placeholders and mount when scrolled toward.
              const initiallyNearViewport = index >= rowCount - INITIAL_MOUNTED_TAIL_ROWS;

              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <LazyMessageRow
                    key={`tool-group-${getMessageKey(item.messages[0])}`}
                    lazyRows={lazyRows}
                    timestamp={item.timestamp}
                    initiallyNearViewport={initiallyNearViewport}
                  >
                    <ToolGroupContainer
                      group={item}
                      prevMessage={groupPrevMessage}
                      createDiff={createDiff}
                      getMessageKey={getGroupedMessageKey}
                      onFileOpen={onFileOpen}
                      onShowSettings={onShowSettings}
                      onGrantToolPermission={onGrantToolPermission}
                      showRawParameters={showRawParameters}
                      showThinking={showThinking}
                      selectedProject={selectedProject}
                      provider={provider}
                    />
                  </LazyMessageRow>
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              return (
                <LazyMessageRow
                  key={getMessageKey(item)}
                  lazyRows={lazyRows}
                  timestamp={item.timestamp}
                  initiallyNearViewport={initiallyNearViewport}
                >
                  <MessageComponent
                    message={item}
                    prevMessage={messagePrevMessage}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onEditMessage={onEditMessage}
                    onForkFromMessage={onForkFromMessage}
                  />
                </LazyMessageRow>
              );
            });
          })()}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
