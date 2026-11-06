import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, X } from 'lucide-react';

import {
  dismissExpiredPermission,
  getExpiredPermissions,
  subscribeExpiredPermissions,
} from '@/shared/transport/expired-permissions';

/**
 * Rendered by ChatComposer above the permission cards. In a Remote tab a card
 * that lapsed (timed out, or answered elsewhere) would otherwise just vanish
 * when the server sends `permission_cancelled`, possibly replayed after a
 * reconnect; this keeps one line per lapsed request until it is dismissed.
 * The wording stays neutral because the message does not say why it lapsed. Renders nothing in Local mode, where nothing
 * is ever recorded.
 */
export default function ExpiredPermissionNotice() {
  const { t } = useTranslation('chat');
  const expired = useSyncExternalStore(subscribeExpiredPermissions, getExpiredPermissions);

  if (expired.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-3 max-w-[54.25rem] space-y-2">
      {expired.map((entry) => (
        <div
          key={entry.requestId}
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-foreground"
        >
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1">
            {t('permissions.expired', {
              defaultValue: 'The permission request for {{tool}} expired. Ask again to retry.',
              tool: entry.toolName,
            })}
          </p>
          <button
            type="button"
            onClick={() => dismissExpiredPermission(entry.requestId)}
            aria-label={t('permissions.expiredDismiss', { defaultValue: 'Dismiss' })}
            className="rounded-md p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
