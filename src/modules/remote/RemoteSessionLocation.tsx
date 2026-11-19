import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { isTargetMode } from '@/shared/transport/target-context';
import { isSessionPath, REMOTE_SESSION_PATH_KEY } from '@/shared/transport/navigation-storage';

/** The target storage shim scopes this location to its Host and hydrates it
 * before App mounts. Explicit session links win; a later visit to / (New
 * Session, deleted session, etc.) clears the old location instead of reopening it.
 */
export function RemoteSessionLocation({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const target = isTargetMode();
  const [restorePath, setRestorePath] = useState(() => {
    if (!target || pathname !== '/') return null;
    try {
      const saved = localStorage.getItem(REMOTE_SESSION_PATH_KEY);
      return isSessionPath(saved) ? saved : null;
    } catch { return null; }
  });

  useEffect(() => {
    if (!target) return;
    if (restorePath) {
      setRestorePath(null);
      navigate(restorePath, { replace: true });
      return;
    }
    try {
      if (isSessionPath(pathname)) localStorage.setItem(REMOTE_SESSION_PATH_KEY, pathname);
      else localStorage.removeItem(REMOTE_SESSION_PATH_KEY);
    } catch { /* A disabled/full store must not break the workspace. */ }
  }, [navigate, pathname, restorePath, target]);

  // Do not mount the root workspace while restoring: its project-selection
  // effects could otherwise race the saved session's route.
  return restorePath ? null : children;
}
