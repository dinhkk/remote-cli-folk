import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { isTargetMode } from '@/shared/transport/target-context';

// In a Host frame the existing storage bridge namespaces this key by peer id.
export const TARGET_CONVERSATION_KEY = 'remotecli:conversation-path';
const CONVERSATION_PATH = /^\/session\/[A-Za-z0-9_-]{1,128}$/;

/** Restore navigation only; session loading and message submission remain with the workspace. */
export function TargetConversationNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const initial = useRef(true);
  const restoring = useRef<string | null>(null);

  useEffect(() => {
    if (!isTargetMode()) return;
    try {
      if (initial.current) {
        initial.current = false;
        const saved = localStorage.getItem(TARGET_CONVERSATION_KEY);
        if (saved !== null && !CONVERSATION_PATH.test(saved)) {
          localStorage.removeItem(TARGET_CONVERSATION_KEY);
        }
        if (pathname === '/' && saved && CONVERSATION_PATH.test(saved)) {
          restoring.current = saved;
          navigate(saved, { replace: true });
          return;
        }
      }
      // StrictMode can replay the initial effect before navigation has committed.
      if (restoring.current && pathname === '/') return;
      restoring.current = null;
      if (CONVERSATION_PATH.test(pathname)) localStorage.setItem(TARGET_CONVERSATION_KEY, pathname);
      else if (pathname === '/') localStorage.removeItem(TARGET_CONVERSATION_KEY);
    } catch {
      // Unavailable browser storage must not prevent ordinary navigation.
    }
  }, [pathname, navigate]);

  return null;
}
