import { useTranslation } from 'react-i18next';

/**
 * Rendered by the auth module's ProtectedRoute inside a Remote tab that has no
 * session yet: the Controller page has not handed over a tab token (still
 * pending, or it could not be issued). It stands in for the login form, which
 * a tab never shows - signing in there would put credentials in a frame that
 * is meant to hold none.
 */
export default function TargetSessionUnavailable() {
  const { t } = useTranslation('auth');

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="max-w-sm text-center" role="status" aria-live="polite">
        <h1 className="mb-2 text-lg font-semibold text-foreground">
          {t('target.waitingTitle', { defaultValue: 'Waiting for the session' })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('target.waitingBody', {
            defaultValue:
              'This tab gets its session from the page that opened it. If this does not clear up, close the tab and open it again.',
          })}
        </p>
      </div>
    </div>
  );
}
