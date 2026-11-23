/** Browser sessions are HttpOnly cookies; only scoped Remote tab tokens are readable here. */
import { getTabToken, isTargetMode } from '@/shared/transport/target-context';

export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

export const expireAuthSession = (): void => {
  if (isTargetMode()) return;
  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
};

export const getStoredAuthToken = (): string | null => {
  if (isTargetMode()) return getTabToken();
  localStorage.removeItem('auth-token');
  return null;
};
