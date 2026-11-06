import { useTranslation } from 'react-i18next';
import { ShieldAlert, X } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';

/**
 * Rendered by the auth module's ProtectedRoute above the workspace.
 * Shown after a login that the server flagged `passwordWeak` (the password is
 * older than the 12 character rule): it still works, but the user is nudged to
 * pick a longer one. Dismissing hides it until the next such login.
 */
export default function PasswordWeakBanner() {
  const { t } = useTranslation('auth');
  const { passwordWeak, dismissPasswordWeak } = useAuth();

  if (!passwordWeak) {
    return null;
  }

  return (
    <div role="alert" className="pointer-events-none fixed inset-x-0 top-0 z-[10000] flex justify-center p-2">
      <div className="pointer-events-auto flex max-w-xl items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:bg-amber-950 dark:text-amber-100">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0 flex-1">
          {t('passwordWeak.message', {
            defaultValue:
              'Your password is shorter than the 12 characters now required. It still works, but please choose a longer one.',
          })}
        </p>
        <button
          type="button"
          onClick={dismissPasswordWeak}
          aria-label={t('passwordWeak.dismiss', { defaultValue: 'Dismiss' })}
          className="rounded-md p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
