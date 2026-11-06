import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';

import { TARGET_LINK_ERROR_AUTOHIDE_MS } from '@/shared/constants';
import { isSessionExpired, isTargetMode, onLinkEvent } from '@/shared/transport/target-context';

type LinkError = { code: string; status: number; id: number };

let nextErrorId = 0;

/**
 * Status layer of a Remote tab, rendered by App. Shows nothing in Local mode
 * and while the link is healthy. A relayed 502/503 becomes a dismissible link
 * message that hides itself; a tab that has no usable session covers the
 * workspace until the Controller page sends a new token. Neither ever signs
 * the Controller out: this is a link problem, not a login problem.
 */
export function TargetStatusOverlay({ onReload = () => window.location.reload() }: { onReload?: () => void }) {
  const { t } = useTranslation('remote');
  // The most recent link problem; replaced by the next one, cleared by the timer or by hand.
  const [linkError, setLinkError] = useState<LinkError | null>(null);
  // Initialised from the sticky flag so a cover raised before this mounted still shows.
  const [expired, setExpired] = useState(() => isSessionExpired());
  const inTarget = isTargetMode();

  useEffect(() => {
    if (!inTarget) return undefined;
    return onLinkEvent((event) => {
      if (event.kind === 'link-error') {
        nextErrorId += 1;
        setLinkError({ code: event.code, status: event.status, id: nextErrorId });
      } else if (event.kind === 'session-expired') {
        setExpired(true);
      } else {
        setExpired(false);
      }
    });
  }, [inTarget]);

  const errorId = linkError?.id;
  useEffect(() => {
    if (errorId === undefined) return undefined;
    const timer = setTimeout(() => setLinkError(null), TARGET_LINK_ERROR_AUTOHIDE_MS);
    return () => clearTimeout(timer);
  }, [errorId]);

  if (!inTarget) {
    return null;
  }

  return (
    <>
      {linkError && (
        <div role="alert" className="pointer-events-none fixed inset-x-0 top-0 z-[10000] flex justify-center p-2">
          <div className="pointer-events-auto flex max-w-xl items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:bg-amber-950 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1">
              {t(`target.linkError.${linkError.code}`, { defaultValue: t('target.linkError.generic') })}
            </p>
            <button
              type="button"
              onClick={() => setLinkError(null)}
              aria-label={t('target.dismiss')}
              className="rounded-md p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {expired && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="target-session-expired-title"
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
        >
          <div className="max-w-sm text-center">
            <h2 id="target-session-expired-title" className="mb-2 text-lg font-semibold text-foreground">
              {t('target.sessionExpiredTitle')}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {t('target.sessionExpiredBody')}
            </p>
            {/* A reloaded frame is a new document the Controller page pairs from scratch with a fresh nonce. */}
            <button
              type="button"
              onClick={onReload}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {t('target.sessionExpiredReload')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
