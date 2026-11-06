import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { UnverifiedDeviceName } from '@/modules/remote/components/UnverifiedDeviceName';
import { useReauthPrompt } from '@/modules/remote/hooks/useReauthPrompt';
import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { formatRemoteTime } from '@/modules/remote/utils/format-remote-time';
import { Button } from '@/shared/ui';
import type { RemoteHostController } from '@/shared/types';

type RevokeNotice = { id: number; name: string; relayConfirmed: boolean };

let nextNoticeId = 0;

type HostControllersPanelProps = {
  controllers: RemoteHostController[];
  /** Called after a Controller was disconnected or revoked, so the screen re-reads the status. */
  onChanged: () => void;
  /** Sits next to the heading, for the "Pair a Controller" button. */
  headerAction?: ReactNode;
};

/**
 * The Controllers paired with this Host (FR-14 to FR-16): name (always marked
 * unverified), when it connected and how many streams it has open. Disconnect ends
 * a link now and needs no password; Revoke deletes the pairing, needs the password
 * and reports plainly when the relay could not confirm it. Rendered by RemoteSettingsTab.
 */
export function HostControllersPanel({ controllers, onChanged, headerAction }: HostControllersPanelProps) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  const { requestReauth, reauthModal } = useReauthPrompt();
  // The Controller being disconnected, to block a double press.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Outcomes of revocations; kept after the Controller leaves the list so an unconfirmed one stays visible.
  const [notices, setNotices] = useState<RevokeNotice[]>([]);
  // True after an action the server refused or could not carry out.
  const [actionFailed, setActionFailed] = useState(false);

  const disconnect = async (controller: RemoteHostController) => {
    setBusyId(controller.pairingId);
    setActionFailed(false);
    const result = await remote.disconnectController(controller.pairingId);
    setBusyId(null);
    if (result.ok) onChanged();
    else setActionFailed(true);
  };

  const revoke = async (controller: RemoteHostController) => {
    setActionFailed(false);
    const result = await requestReauth({
      title: t('controllers.revokeTitle'),
      description: t('controllers.revokeDescription', { name: controller.name }),
      run: (password) => remote.revokeController(controller.pairingId, password),
    });
    if (result === null) return;
    if (!result.ok) {
      setActionFailed(true);
      return;
    }
    nextNoticeId += 1;
    setNotices((previous) => [
      ...previous,
      { id: nextNoticeId, name: controller.name, relayConfirmed: result.data.relayConfirmed },
    ]);
    onChanged();
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{t('controllers.title')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('controllers.description')}</p>
        </div>
        {headerAction}
      </div>

      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
            notice.relayConfirmed
              ? 'border-border text-foreground'
              : 'border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
          }`}
        >
          <p className="min-w-0 flex-1">
            {t(notice.relayConfirmed ? 'controllers.revokedConfirmed' : 'controllers.revokedUnconfirmed', {
              name: notice.name,
            })}
          </p>
          <button
            type="button"
            className="shrink-0 text-xs underline"
            onClick={() => setNotices((previous) => previous.filter((entry) => entry.id !== notice.id))}
          >
            {t('controllers.dismiss')}
          </button>
        </div>
      ))}

      {controllers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('controllers.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {controllers.map((controller) => {
            const connectedAt = formatRemoteTime(controller.connectedAt);
            const suspendedUntil = formatRemoteTime(controller.suspendedUntil);
            return (
              <li key={controller.pairingId} className="space-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <UnverifiedDeviceName name={controller.name} />
                  {controller.connected ? (
                    <>
                      {connectedAt && (
                        <span className="text-xs text-muted-foreground">
                          {t('controllers.connectedAt', { time: connectedAt })}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {t('controllers.streams', { count: controller.streams })}
                      </span>
                    </>
                  ) : suspendedUntil ? (
                    <>
                      <span className="text-xs font-medium text-destructive">{t('controllers.suspendedUntil', { time: suspendedUntil })}</span>
                      <span className="text-xs text-muted-foreground">{t('controllers.suspendedReason')}</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('controllers.notConnected')}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!controller.connected || busyId === controller.pairingId}
                    onClick={() => void disconnect(controller)}
                  >
                    {t('controllers.disconnect')}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void revoke(controller)}>
                    {t('controllers.revoke')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {actionFailed && (
        <p role="alert" className="text-sm text-destructive">
          {t('controllers.actionFailed')}
        </p>
      )}
      {reauthModal}
    </section>
  );
}
