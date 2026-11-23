import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { api, readApiErrorMessage } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import { purgeRemoteTabStorage } from '@/shared/transport/controller-tab-storage';
import { isTargetMode, onTabTokenChange, readTabTokenUser } from '@/shared/transport/target-context';
/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

// In a Remote tab the real credential is the tab token, which lives in the
// transport's ref so that renewing it never re-renders consumers or reconnects
// sockets. Consumers only test `token` for presence, so this stable stand-in
// is what they see; it is never sent anywhere.
const TARGET_TOKEN_MARKER = 'remote-tab-session';
const COOKIE_SESSION_MARKER = 'cookie-session'; // UI state only; never sent as a credential.

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  registrationFailed: 'errors.registrationFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthSessionPayload = {
  user?: AuthUser;
  // Set by the server when a login used a password shorter than today's minimum.
  passwordWeak?: boolean;
};

type AuthStatusPayload = {
  needsSetup?: boolean;
};

type AuthUserPayload = {
  user?: AuthUser;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  /** True after a login with a password below today's minimum length; drives the "choose a longer password" banner. */
  passwordWeak: boolean;
  dismissPasswordWeak: () => void;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string, setupToken?: string) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => (isTargetMode() ? TARGET_TOKEN_MARKER : null));
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Remembers, for this page load only, that the last login used a weak password so the banner can show.
  const [passwordWeak, setPasswordWeak] = useState(false);

  const dismissPasswordWeak = useCallback(() => setPasswordWeak(false), []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    setPasswordWeak(false);
    clearStoredToken();
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  // Signing out, or losing the session, also ends what Remote tabs stored here on behalf of their
  // Hosts. (Inside a tab "localStorage" is an in-memory stand-in: nothing real to purge.)
  const endRemoteTabData = useCallback(() => {
    if (!isTargetMode()) {
      purgeRemoteTabStorage();
    }
  }, []);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  useEffect(() => {
    const handleSessionExpired = () => {
      // A Remote tab never owns a session: the Controller page does.
      if (isTargetMode()) {
        return;
      }
      clearSession();
      endRemoteTabData();
      setError(t(AUTH_ERROR_MESSAGES.sessionExpired));
    };

    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [clearSession, endRemoteTabData, t]);

  // The startup check below needs `t` only for its failure message.
  // react-i18next gives `t` a new identity on every language change, so
  // depending on it would re-run that check - and swap the whole app for the
  // loading screen - whenever the language changes, including when sign-in
  // adopts the language saved on another device.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      clearStoredToken();
      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      setToken(COOKIE_SESSION_MARKER);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(tRef.current(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession]);

  // Remote tab: the Controller page already signed the user in and handed the
  // frame a tab token, so there is no login and no auth probe. The user shown
  // comes from the token's claims, and a token that arrives after a gap signs
  // the tab in. Renewals later change nothing here.
  useEffect(() => {
    if (!isTargetMode()) {
      return undefined;
    }
    let adopted = false;
    let cancelled = false;
    const adoptTabUser = () => {
      if (adopted) {
        return;
      }
      const tabUser = readTabTokenUser();
      if (!tabUser) {
        setIsLoading(false);
        return;
      }
      adopted = true;
      setUser(tabUser);
      void checkOnboardingStatus().finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    };
    adoptTabUser();
    const unsubscribe = onTabTokenChange((next) => {
      if (next) {
        adoptTabUser();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [checkOnboardingStatus]);

  useEffect(() => {
    if (isTargetMode()) {
      return;
    }
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  // The cookie is installed by the browser before onboarding requests run.
  const publishSession = useCallback(async (nextUser: AuthUser) => {
    clearStoredToken();
    await checkOnboardingStatus();
    setUser(nextUser);
    setToken(COOKIE_SESSION_MARKER);
    setNeedsSetup(false);
  }, [checkOnboardingStatus]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.user) {
          // Most auth failures arrive as the structured AppError envelope; passing its
          // `error` object on would render it as a React child and blank the screen.
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user);
        setPasswordWeak(payload.passwordWeak === true);
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password, setupToken) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password, setupToken);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.user) {
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user);
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  const logout = useCallback(async () => {
    try {
      const response = await api.auth.logout();
      if (!response.ok && response.status !== 401) throw new Error('Sign out failed');
      clearSession();
      endRemoteTabData();
    } catch {
      setError(t(AUTH_ERROR_MESSAGES.networkError));
    }
  }, [clearSession, endRemoteTabData, t]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      passwordWeak,
      dismissPasswordWeak,
      login,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      dismissPasswordWeak,
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      passwordWeak,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
