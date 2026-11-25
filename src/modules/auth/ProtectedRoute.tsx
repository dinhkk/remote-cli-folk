import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { isTargetMode } from '@/shared/transport/target-context';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import PasswordWeakBanner from '@/modules/auth/PasswordWeakBanner';
import TargetSessionUnavailable from '@/modules/auth/TargetSessionUnavailable';
import LoginForm from '@/modules/auth/LoginForm';
import SessionLockScreen from '@/modules/auth/SessionLockScreen';
import SetupForm from '@/modules/auth/SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, isLocked, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  // A Remote tab has no login: its session is whatever the Controller page hands over.
  if (isTargetMode()) {
    if (!user) {
      return <TargetSessionUnavailable />;
    }
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }
    return <>{children}</>;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (isLocked) return <SessionLockScreen />;

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return (
    <>
      <PasswordWeakBanner />
      {children}
    </>
  );
}
