/** Browser sessions are HttpOnly cookies; only scoped Remote tab tokens are readable here. */
import { getTabToken, isTargetMode } from '@/shared/transport/target-context';

export const AUTH_SESSION_LOCKED_EVENT = 'auth-session-locked';

/** Lock preserves the cookie and navigation; unlocking is verified by the server. */
export const lockAuthSession = (): void => {
  if (isTargetMode()) return;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_SESSION_LOCKED_EVENT));
};

export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

export const expireAuthSession = (reason?: string | null): void => {
  if (isTargetMode()) return;
  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_SESSION_EXPIRED_EVENT, { detail: reason }));
};

export const getStoredAuthToken = (): string | null => {
  if (isTargetMode()) return getTabToken();
  localStorage.removeItem('auth-token');
  return null;
};

let handler: (() => Promise<boolean>) | null = null;
let pending: Promise<boolean> | null = null;

/** Requests share one visible prompt. The caller retries only its refused request, once. */
export function requestMfaReauth(): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  if (!pending) pending = handler().finally(() => { pending = null; });
  return pending;
}
export function registerMfaReauth(next: () => Promise<boolean>): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}
