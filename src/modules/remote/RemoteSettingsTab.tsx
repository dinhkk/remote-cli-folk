import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuditPanel } from '@/modules/remote/components/AuditPanel';
import { HostAcceptToggle } from '@/modules/remote/components/HostAcceptToggle';
import { HostControllersPanel } from '@/modules/remote/components/HostControllersPanel';
import { PeerList } from '@/modules/remote/components/PeerList';
import { RelayConfigPanel } from '@/modules/remote/components/RelayConfigPanel';
import { RemoteWarningsPanel } from '@/modules/remote/components/RemoteWarningsPanel';
import { useReauthPrompt } from '@/modules/remote/hooks/useReauthPrompt';
import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { useRemotePolling } from '@/modules/remote/hooks/useRemotePolling';
import { PairControllerDialog } from '@/modules/remote/modals/PairControllerDialog';
import { PairHostDialog } from '@/modules/remote/modals/PairHostDialog';
import { formatRemoteTime } from '@/modules/remote/utils/format-remote-time';
import { requestOpenRemoteTab } from '@/modules/remote/utils/open-remote-tab-request';
import { Button } from '@/shared/ui';
import type { RemoteApiResult, RemoteHostPairingStart, RemoteRelayConfig } from '@/shared/types';

// Error codes (contracts.md section 9 and FR-41) that the screen turns into a warning of its own.
const MASTER_KEY_MISMATCH = 'MASTER_KEY_MISMATCH';
const UNSUPPORTED_MODE = 'REMOTE_UNSUPPORTED_MODE';

/**
 * The "Remote work" tab of Settings: relay, Accept switch, pairing, the Controllers
 * of this Host, the Hosts this browser controls and, last, the read-only Host audit
 * log (paged, read on open and on request, not polled). One shared poll (host status
 * plus peers, every 2 s) feeds every section; the relay settings are read once and
 * again after a save. On a server without the Remote module it shows one line.
 * Rendered by the settings module's Settings dialog.
 */
export function RemoteSettingsTab({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  const { snapshot, refresh } = useRemotePolling('full');
  const { requestReauth, reauthModal } = useReauthPrompt();
  // The relay settings as the server last reported them; null until the first answer.
  const [relay, setRelay] = useState<RemoteApiResult<RemoteRelayConfig> | null>(null);
  // The pairing the Host dialog is showing; null when it is closed.
  const [hostPairing, setHostPairing] = useState<RemoteHostPairingStart | null>(null);
  // Whether the Controller's join dialog is open.
  const [isJoinOpen, setIsJoinOpen] = useState(false);
  // When too many wrong verification codes lock new pairings (epoch ms); null when not locked.
  const [pairingLockedUntil, setPairingLockedUntil] = useState<number | null>(null);
  // True after starting a pairing failed for a reason other than the password.
  const [startFailed, setStartFailed] = useState(false);

  // Read once on open and again after a save; the poll does not carry the relay settings.
  useEffect(() => {
    let cancelled = false;
    void remote.loadRelayConfig().then((result) => {
      if (!cancelled) setRelay(result);
    });
    return () => {
      cancelled = true;
    };
  }, [remote]);
  const reloadRelay = useCallback(async () => {
    setRelay(await remote.loadRelayConfig());
  }, [remote]);

  // The lock lifts by itself; re-enable the button at that moment.
  useEffect(() => {
    if (pairingLockedUntil === null) return undefined;
    const timer = setTimeout(() => setPairingLockedUntil(null), Math.max(0, pairingLockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [pairingLockedUntil]);

  const reload = useCallback(() => void refresh(), [refresh]);
  const relayConfig = relay?.ok ? relay.data : null;
  const relayFailureCode = relay && !relay.ok ? relay.code : null;
  const failureCodes = [snapshot.failure?.code, relayFailureCode];
  const masterKeyMismatch = failureCodes.includes(MASTER_KEY_MISMATCH) || snapshot.host?.relayState === MASTER_KEY_MISMATCH;
  const unsupportedMode = failureCodes.includes(UNSUPPORTED_MODE);
  const relayReady = relayConfig !== null && relayConfig.url !== '' && relayConfig.hasSecret;
  const canPair = relayReady && !unsupportedMode && !masterKeyMismatch;

  const startHostPairing = async () => {
    setStartFailed(false);
    const result = await requestReauth({
      title: t('pairHost.startTitle'),
      description: t('pairHost.startDescription'),
      run: (password) => remote.startPairing(password),
    });
    if (result === null) return;
    if (result.ok) setHostPairing(result.data);
    else setStartFailed(true);
  };

  const openPeer = (peerId: string) => {
    requestOpenRemoteTab(peerId);
    onClose();
  };

  if (!snapshot.loaded || relay === null) {
    return <p className="text-sm text-muted-foreground">{t('settings.loading')}</p>;
  }
  if (!snapshot.available) {
    return <p className="text-sm text-muted-foreground">{t('settings.unavailable')}</p>;
  }

  const isLocked = pairingLockedUntil !== null;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('settings.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.description')}</p>
      </div>

      <RemoteWarningsPanel
        masterKeySource={relayConfig?.masterKeySource ?? null}
        masterKeyMismatch={masterKeyMismatch}
        unsupportedMode={unsupportedMode}
        approvalTimeoutMs={snapshot.host?.approvalTimeoutMs ?? null}
      />

      {relayConfig ? (
        <RelayConfigPanel config={relayConfig} onSaved={() => void reloadRelay().then(reload)} />
      ) : (
        !masterKeyMismatch && !unsupportedMode && <p className="text-sm text-destructive">{t('settings.loadFailed')}</p>
      )}

      <HostAcceptToggle
        status={snapshot.host}
        relayReady={relayReady && !masterKeyMismatch}
        unsupported={unsupportedMode}
        onChanged={reload}
      />

      <HostControllersPanel
        controllers={snapshot.host?.controllers ?? []}
        onChanged={reload}
        headerAction={
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <Button size="sm" disabled={!canPair || isLocked} onClick={() => void startHostPairing()}>
              {t('pairHost.start')}
            </Button>
            {isLocked && (
              <p className="text-xs text-muted-foreground">
                {t('pairHost.lockedUntil', { time: formatRemoteTime(pairingLockedUntil) })}
              </p>
            )}
            {startFailed && (
              <p role="alert" className="text-xs text-destructive">
                {t('pairHost.startFailed')}
              </p>
            )}
          </div>
        }
      />

      <PeerList
        peers={snapshot.peers}
        onOpen={openPeer}
        onChanged={reload}
        headerAction={
          <Button size="sm" disabled={!canPair} onClick={() => setIsJoinOpen(true)}>
            {t('pairController.start')}
          </Button>
        }
      />

      {!unsupportedMode && <AuditPanel />}

      {hostPairing && (
        <PairHostDialog
          key={hostPairing.pairingId}
          pairing={hostPairing}
          onClose={() => setHostPairing(null)}
          onPaired={reload}
          onLocked={setPairingLockedUntil}
        />
      )}
      {isJoinOpen && <PairControllerDialog onClose={() => setIsJoinOpen(false)} onPaired={reload} />}
      {reauthModal}
    </div>
  );
}
