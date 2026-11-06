import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { RemoteModalFrame } from '@/modules/remote/modals/RemoteModalFrame';
import { formatPairingCode, isPairingCodeComplete } from '@/modules/remote/utils/pairing-code';
import { REMOTE_PEERS_POLL_INTERVAL_MS } from '@/shared/constants';
import { Button, Input } from '@/shared/ui';
import type { RemoteJoinProgress } from '@/shared/types';

// contracts.md section 4: a device name is at most 32 characters of [A-Za-z0-9 ._-].
const DEVICE_NAME_MAX_LENGTH = 32;
const sanitizeDeviceName = (value: string): string =>
  value.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, DEVICE_NAME_MAX_LENGTH);

type FailureKind = 'expired' | 'wrongCode' | 'full' | 'rejected' | 'generic';

// The server's reason is a free-form code; map the families of reasons the user can act on to a message of their own.
const describeFailure = (reason: string | null): FailureKind => {
  const text = (reason ?? '').toLowerCase();
  if (/expire/.test(text)) return 'expired';
  if (/full|max|limit/.test(text)) return 'full';
  if (/sas|reject|lock|attempt|denied/.test(text)) return 'rejected';
  if (/code|invalid|not.?found|unknown|room/.test(text)) return 'wrongCode';
  return 'generic';
};

type PairControllerDialogProps = {
  onClose: () => void;
  /** Called once when the Host confirmed, so the screen re-reads the list of Hosts. */
  onPaired: () => void;
};

/**
 * Controller side of pairing (FR-4 to FR-7): type the code the Host shows, then read
 * the 6-digit verification code off this screen and type it on the Host. This side
 * only displays the verification code; nothing here can approve a pairing, which
 * is what makes a man in the middle detectable. Rendered by RemoteSettingsTab.
 */
export function PairControllerDialog({ onClose, onPaired }: PairControllerDialogProps) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  // The code as shown, always normalised to XXXX-XXXX.
  const [code, setCode] = useState('');
  // The name this browser will be listed under on the Host.
  const [deviceName, setDeviceName] = useState(() => t('pairController.deviceNameDefault'));
  // The join being followed; null while the form is showing.
  const [joinId, setJoinId] = useState<string | null>(null);
  // The latest answer about that join (carries the verification code to show).
  const [progress, setProgress] = useState<RemoteJoinProgress | null>(null);
  // Why the server refused the code outright, shown on the form.
  const [formFailure, setFormFailure] = useState<FailureKind | null>(null);
  // Blocks a second submit while the join request is in flight.
  const [isStarting, setIsStarting] = useState(false);

  // The latest callback, so a parent re-render never restarts the polling below.
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  });

  useEffect(() => {
    if (joinId === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const follow = async () => {
      const result = await remote.readJoin(joinId);
      if (stopped) return;
      if (result.ok) {
        setProgress(result.data);
        if (result.data.state === 'done') {
          onPairedRef.current();
          return;
        }
        if (result.data.state === 'failed') return;
      } else if (result.status === 404 || result.status === 410) {
        // The server no longer knows this join: nothing more will happen.
        setProgress({ state: 'failed', sas: null, peerId: null, failure: null });
        return;
      }
      timer = setTimeout(() => void follow(), REMOTE_PEERS_POLL_INTERVAL_MS);
    };
    void follow();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [joinId, remote]);

  const handleJoin = async (event: FormEvent) => {
    event.preventDefault();
    if (!isPairingCodeComplete(code) || deviceName.trim() === '' || isStarting) return;
    setFormFailure(null);
    setIsStarting(true);
    const result = await remote.joinHost(code, deviceName.trim());
    setIsStarting(false);
    if (result.ok) {
      setProgress(null);
      setJoinId(result.data);
    } else {
      setFormFailure(describeFailure(result.code ?? (result.status === 404 ? 'not_found' : null)));
    }
  };

  const resetToForm = () => {
    setJoinId(null);
    setProgress(null);
    setFormFailure(null);
  };

  const failed = progress?.state === 'failed';
  const done = progress?.state === 'done';

  let body;
  if (joinId === null) {
    body = (
      <form onSubmit={handleJoin} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="remote-pair-code" className="text-sm font-medium text-foreground">
            {t('pairController.codeLabel')}
          </label>
          <Input
            id="remote-pair-code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            className="font-mono tracking-widest"
            placeholder={t('pairController.codePlaceholder')}
            value={code}
            onChange={(event) => setCode(formatPairingCode(event.target.value))}
          />
          <p className="text-xs text-muted-foreground">{t('pairController.codeHelp')}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="remote-pair-device-name" className="text-sm font-medium text-foreground">
            {t('pairController.deviceNameLabel')}
          </label>
          <Input
            id="remote-pair-device-name"
            autoComplete="off"
            maxLength={DEVICE_NAME_MAX_LENGTH}
            value={deviceName}
            onChange={(event) => setDeviceName(sanitizeDeviceName(event.target.value))}
          />
          <p className="text-xs text-muted-foreground">{t('pairController.deviceNameHelp')}</p>
        </div>
        {formFailure && (
          <p role="alert" className="text-sm text-destructive">
            {t(`pairController.failure.${formFailure}`)}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('pairController.close')}
          </Button>
          <Button type="submit" disabled={!isPairingCodeComplete(code) || deviceName.trim() === '' || isStarting}>
            {t('pairController.join')}
          </Button>
        </div>
      </form>
    );
  } else {
    body = (
      <div className="space-y-4">
        {done && <p className="text-sm text-foreground">{t('pairController.done')}</p>}
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t(`pairController.failure.${describeFailure(progress?.failure ?? null)}`)}
          </p>
        )}
        {!done && !failed && progress?.sas && (
          <div className="space-y-2">
            <output
              aria-label={t('pairController.sasLabel')}
              className="block text-center font-mono text-4xl font-semibold tracking-[0.3em] text-foreground"
            >
              {`${progress.sas.slice(0, 3)} ${progress.sas.slice(3)}`}
            </output>
            <p className="text-sm text-muted-foreground">{t('pairController.sasHelp')}</p>
            <p className="text-sm text-muted-foreground">{t('pairController.waitingHost')}</p>
          </div>
        )}
        {!done && !failed && !progress?.sas && (
          <p className="text-sm text-muted-foreground">{t('pairController.joining')}</p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {failed && (
            <Button type="button" variant="outline" onClick={resetToForm}>
              {t('pairController.tryAgain')}
            </Button>
          )}
          <Button type="button" variant={done ? 'default' : 'outline'} onClick={onClose}>
            {t('pairController.close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <RemoteModalFrame title={t('pairController.title')} onClose={onClose}>
      {body}
    </RemoteModalFrame>
  );
}
