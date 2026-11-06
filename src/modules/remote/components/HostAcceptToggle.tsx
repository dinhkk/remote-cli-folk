import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useReauthPrompt } from '@/modules/remote/hooks/useReauthPrompt';
import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { formatRemoteTime } from '@/modules/remote/utils/format-remote-time';
import { Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { RemoteHostStatus } from '@/shared/types';

// Contract bounds for the automatic switch-off (contracts.md section 8): 1-168 hours, 0 = never.
const MAX_AUTO_OFF_HOURS = 168;

type HostAcceptToggleProps = {
  /** Null until the first status answer arrived. */
  status: RemoteHostStatus | null;
  /** Whether a relay address and secret are saved; Accept cannot be turned on without one. */
  relayReady: boolean;
  /** True when the server mode cannot run Remote at all. */
  unsupported?: boolean;
  /** Called after Accept changed, so the screen re-reads the status. */
  onChanged: () => void;
};

/**
 * The Accept switch of the Host (FR-8 to FR-13): while it is on, paired Controllers
 * may connect. Changing it either way needs the account password (PUT /host/accept
 * is marked `*`). Before turning on, the owner picks the automatic switch-off in
 * hours; once on, the time it will turn itself off is shown. Rendered by RemoteSettingsTab.
 */
export function HostAcceptToggle({ status, relayReady, unsupported = false, onChanged }: HostAcceptToggleProps) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  const { requestReauth, reauthModal } = useReauthPrompt();
  // What the owner typed for the auto-off hours; null means "show what the Host reports".
  const [editedHours, setEditedHours] = useState<number | null>(null);
  // Why the last change did not go through, as a translation key.
  const [problem, setProblem] = useState<'failed' | 'unsupported' | null>(null);

  const acceptEnabled = status?.acceptEnabled ?? false;
  const hours = editedHours ?? status?.autoOffHours ?? 0;
  const autoOffAt = acceptEnabled && status ? formatRemoteTime(status.autoOffAt) : '';
  const isDisabled = !status || (!acceptEnabled && (!relayReady || unsupported));

  const handleToggle = async () => {
    if (!status) return;
    const enable = !acceptEnabled;
    setProblem(null);
    const result = await requestReauth({
      title: t(enable ? 'accept.turnOnTitle' : 'accept.turnOffTitle'),
      description: t('accept.reauthDescription'),
      run: (password) => remote.setAccept(enable, enable ? hours : undefined, password),
    });
    if (result === null) return;
    if (result.ok) {
      onChanged();
    } else {
      setProblem(result.code === 'REMOTE_UNSUPPORTED_MODE' ? 'unsupported' : 'failed');
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{t('accept.title')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('accept.description')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={acceptEnabled}
          aria-label={t('accept.switchLabel')}
          disabled={isDisabled}
          onClick={() => void handleToggle()}
          className={cn(
            'relative inline-flex h-7 w-12 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full border-2 transition-colors duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            acceptEnabled ? 'border-primary bg-primary' : 'border-border bg-muted',
            isDisabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span
            className={cn(
              'pointer-events-none inline-block h-5 w-5 rounded-full shadow-sm transition-transform duration-200',
              acceptEnabled ? 'translate-x-[22px] bg-white' : 'translate-x-[2px] bg-foreground/60 dark:bg-foreground/80',
            )}
          />
        </button>
      </div>

      {!acceptEnabled && (
        <div className="space-y-1.5">
          <label htmlFor="remote-auto-off-hours" className="text-sm font-medium text-foreground">
            {t('accept.autoOffLabel')}
          </label>
          <Input
            id="remote-auto-off-hours"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_AUTO_OFF_HOURS}
            step={1}
            className="max-w-32"
            value={hours}
            onChange={(event) => {
              const typed = Math.round(Number(event.target.value));
              setEditedHours(Number.isFinite(typed) ? Math.min(MAX_AUTO_OFF_HOURS, Math.max(0, typed)) : 0);
            }}
          />
        </div>
      )}

      {autoOffAt !== '' && (
        <p className="text-sm text-muted-foreground">{t('accept.autoOffAt', { time: autoOffAt })}</p>
      )}
      {!relayReady && !acceptEnabled && <p className="text-sm text-muted-foreground">{t('accept.relayRequired')}</p>}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {t(problem === 'unsupported' ? 'accept.unsupported' : 'accept.failed')}
        </p>
      )}
      {reauthModal}
    </section>
  );
}
