import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { normalizedToChatMessages, type SessionStore } from '@/modules/chat';
import type { ChatMessage } from '@/shared/types';

/** How often the latest history is re-read while a sub-agent of a chat that is not on screen is still working. */
export const ACTIVITY_POLL_MS = 3000;

export type ActivityMessagesStatus = 'loading' | 'ready' | 'error';

/**
 * The chat messages the Activity reads a sub-agent's recorded tool calls from.
 *
 * The session store keeps the chat that is open up to date from the socket, but a chat that is not open gets no events and
 * its slot may not exist at all: it is fetched once, and while `polling` (the agent is working) its latest history is
 * re-read every few seconds, once more when polling stops so the final state is shown. The store's identity never changes
 * and it re-renders only for the open chat, so this hook keeps its own version counter to re-read after each of its own calls.
 */
export function useActivityMessages(sessionStore: SessionStore, chatId: string, polling: boolean): { messages: ChatMessage[]; status: ActivityMessagesStatus } {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);
  const [status, setStatus] = useState<ActivityMessagesStatus>(() => (sessionStore.getMessages(chatId).length > 0 ? 'ready' : 'loading'));

  useEffect(() => {
    if (sessionStore.getMessages(chatId).length > 0) {
      setStatus('ready');
      bump();
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    sessionStore.fetchFromServer(chatId)
      .then((slot) => {
        if (cancelled) return;
        setStatus(slot?.status === 'error' ? 'error' : 'ready');
        bump();
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [chatId, sessionStore, bump]);

  const wasPolling = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (document.hidden) return;
      await sessionStore.refreshLatestFromServer(chatId);
      if (!cancelled) bump();
    };
    if (polling) {
      wasPolling.current = true;
      const timer = setInterval(() => { void refresh(); }, ACTIVITY_POLL_MS);
      return () => { cancelled = true; clearInterval(timer); };
    }
    if (wasPolling.current) {
      wasPolling.current = false;
      void refresh();
    }
    return () => { cancelled = true; };
  }, [polling, chatId, sessionStore, bump]);

  // `version` is the signal that the store changed behind its stable identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => normalizedToChatMessages(sessionStore.getMessages(chatId)), [chatId, sessionStore, version]);
  return { messages, status };
}
