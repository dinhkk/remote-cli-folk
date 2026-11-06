import { useTranslation } from 'react-i18next';

import { useRemotePolling } from '@/modules/remote/hooks/useRemotePolling';

/** Where the indicator sits: a floating pill, or a compact pill at the end of the Remote tab bar. */
export type HostControllerIndicatorPlacement = 'overlay' | 'tabbar';

/**
 * FR-17: while this machine accepts Controllers, the Local UI says how many are
 * connected right now. It is absent when Accept is off or the server has no
 * Remote module.
 *
 * `overlay` (default) is a fixed, click-through pill, so showing or hiding it
 * never moves the app underneath; it is used when there is no tab bar.
 * `tabbar` is a flex item at the end of the Remote tab bar, so on a narrow screen
 * it can never cover a tab (the tabs scroll instead): a dot and the count, with the
 * full sentence from the `sm` breakpoint up, for screen readers and as a tooltip.
 * Rendered through RemoteTabsShell's `indicator` prop, from App inside ProtectedRoute.
 */
export function HostControllerIndicator({ placement = 'overlay' }: { placement?: HostControllerIndicatorPlacement }) {
  const { t } = useTranslation('remote');
  const { snapshot } = useRemotePolling('indicator');
  const host = snapshot.host;

  if (!host?.acceptEnabled) {
    return null;
  }

  const connected = host.controllers.filter((controller) => controller.connected).length;
  const text = t('indicator.connected', { count: connected });
  const tone =
    connected > 0
      ? 'border-emerald-500/40 bg-emerald-50/90 text-emerald-900 dark:bg-emerald-950/90 dark:text-emerald-100'
      : 'border-border bg-background/90 text-muted-foreground';

  if (placement === 'tabbar') {
    return (
      <div
        role="status"
        title={text}
        className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${connected > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
        <span aria-hidden className="sm:hidden">
          {connected}
        </span>
        <span className="sr-only sm:not-sr-only">{text}</span>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-1 z-[60] flex justify-center px-2">
      <div role="status" className={`rounded-full border px-3 py-1 text-xs font-medium shadow-sm backdrop-blur ${tone}`}>
        {text}
      </div>
    </div>
  );
}
