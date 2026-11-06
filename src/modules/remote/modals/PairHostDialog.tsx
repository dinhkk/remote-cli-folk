import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { UnverifiedDeviceName } from '@/modules/remote/components/UnverifiedDeviceName';
import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { RemoteModalFrame } from '@/modules/remote/modals/RemoteModalFrame';
import { formatCountdown, formatRemoteTime, parseRemoteTimestamp } from '@/modules/remote/utils/format-remote-time';
import { formatPairingCode } from '@/modules/remote/utils/pairing-code';
import { REMOTE_PEERS_POLL_INTERVAL_MS } from '@/shared/constants';
import { Button, Input } from '@/shared/ui';
import type { RemoteHostPairing, RemoteHostPairingStart } from '@/shared/types';

const SAS_LENGTH = 6;
// Three wrong verification codes cancel the pairing and lock new ones for this long (FR-5).
const PAIRING_LOCK_MS = 15 * 60_000;
// A fresh code allows this many wrong verification codes.
const SAS_ATTEMPTS = 3;

type PairHostDialogProps = {
  pairing: RemoteHostPairingStart;
  onClose: () => void;
  /** Called once when the pairing completed, so the screen re-reads the Controllers. */
  onPaired: () => void;
  /** Called once when too many wrong codes locked pairing, with the time (epoch ms) it unlocks. */
  onLocked: (lockedUntil: number) => void;
};

/**
 * Host side of pairing: shows the code with its five-minute clock, waits for a
 * Controller to join, then takes the 6 digits that Controller displays. The Host
 * never displays the verification code and there is no way to skip it; three wrong
 * entries cancel the pairing and lock new ones for 15 minutes.
 * Rendered by RemoteSettingsTab after the password prompt started the pairing.
 */
export function PairHostDialog({ pairing, onClose, onPaired, onLocked }: PairHostDialogProps) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  // The latest answer about this pairing; null until the first one arrives.
  const [state, setState] = useState<RemoteHostPairing | null>(null);
  // Ticks once a second so the countdown moves without another request.
  const [now, setNow] = useState(() => Date.now());
  // The digits being typed; emptied after every submit.
  const [sas, setSas] = useState('');
  // Wrong entries so far show as "attempts left"; only ever goes down.
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  // Set when pairing got locked (epoch ms it unlocks); ends the pairing on screen.
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  // True while the typed digits are being checked.
  const [isConfirming, setIsConfirming] = useState(false);
  // True when checking the digits failed for a reason other than a wrong code (server or network).
  const [confirmFailed, setConfirmFailed] = useState(false);
  // Bumped after a correct entry to ask the server for the outcome right away instead of at the next tick.
  const [pollNonce, setPollNonce] = useState(0);

  const expiresAt = parseRemoteTimestamp(pairing.expiresAt) ?? now;
  const remaining = expiresAt - now;
  const isDone = state?.state === 'done';
  const isFailed = state?.state === 'failed' && lockedUntil === null;
  const isExpired = remaining <= 0 && !isDone && lockedUntil === null;
  const isOver = isDone || isFailed || isExpired || lockedUntil !== null;

  // The latest callbacks, so a parent re-render never restarts the polling below.
  const onPairedRef = useRef(onPaired);
  const onLockedRef = useRef(onLocked);
  useEffect(() => {
    onPairedRef.current = onPaired;
    onLockedRef.current = onLocked;
  });
  // Each outcome is reported to the parent once.
  const reported = useRef(false);

  const lock = useCallback((until: number) => {
    setLockedUntil(until);
    if (!reported.current) {
      reported.current = true;
      onLockedRef.current(until);
    }
  }, []);

  useEffect(() => {
    if (isOver) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOver]);

  useEffect(() => {
    if (isOver) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const follow = async () => {
      const result = await remote.readPairing(pairing.pairingId);
      if (stopped) return;
      if (result.ok) {
        const next = result.data;
        setState(next);
        if (next.attemptsLeft !== null) {
          const polled = next.attemptsLeft;
          setAttemptsLeft((previous) => (previous === null ? polled : Math.min(previous, polled)));
        }
        if (next.state === 'done') {
          if (!reported.current) {
            reported.current = true;
            onPairedRef.current();
          }
          return;
        }
        if (next.state === 'failed') {
          if (next.lockedUntil !== null || next.attemptsLeft === 0) {
            lock(parseRemoteTimestamp(next.lockedUntil) ?? Date.now() + PAIRING_LOCK_MS);
          }
          return;
        }
      }
      timer = setTimeout(() => void follow(), REMOTE_PEERS_POLL_INTERVAL_MS);
    };
    void follow();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOver, lock, pairing.pairingId, pollNonce, remote]);

  const handleConfirm = async (event: FormEvent) => {
    event.preventDefault();
    if (sas.length !== SAS_LENGTH || isConfirming) return;
    const sent = sas;
    setSas('');
    setConfirmFailed(false);
    setIsConfirming(true);
    const result = await remote.confirmSas(pairing.pairingId, sent);
    setIsConfirming(false);
    if (!result.ok) {
      setConfirmFailed(true);
    } else if (result.data.ok) {
      setPollNonce((value) => value + 1);
    } else if (result.data.attemptsLeft === 0 || result.data.lockedUntil !== null) {
      lock(parseRemoteTimestamp(result.data.lockedUntil) ?? Date.now() + PAIRING_LOCK_MS);
    } else if (result.data.attemptsLeft !== null) {
      const left = result.data.attemptsLeft;
      setAttemptsLeft((previous) => (previous === null ? left : Math.min(previous, left)));
    }
  };

  let body: ReactNode;
  if (isDone) {
    body = <p className="text-sm text-foreground">{t('pairHost.done')}</p>;
  } else if (lockedUntil !== null) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        {t('pairHost.locked', { time: formatRemoteTime(lockedUntil) })}
      </p>
    );
  } else if (isExpired) {
    body = <p className="text-sm text-muted-foreground">{t('pairHost.expired')}</p>;
  } else if (isFailed) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        {t('pairHost.failed')}
      </p>
    );
  } else {
    const waitingForSas = state?.state === 'awaiting-sas';
    body = (
      <div className="space-y-4">
        <div className="space-y-1">
          <p
            aria-label={t('pairHost.codeLabel')}
            className="text-center font-mono text-3xl font-semibold tracking-[0.2em] text-foreground"
          >
            {formatPairingCode(pairing.code)}
          </p>
          <p className="text-center text-sm text-muted-foreground">{t('pairHost.expiresIn', { time: formatCountdown(remaining) })}</p>
          <p className="text-sm text-muted-foreground">{t('pairHost.codeHelp')}</p>
        </div>

        {waitingForSas ? (
          <form onSubmit={handleConfirm} className="space-y-3">
            <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <UnverifiedDeviceName name={state?.controllerName ?? ''} />
              <span>{t('pairHost.controllerJoined')}</span>
            </p>
            <div className="space-y-1.5">
              <label htmlFor="remote-pair-sas" className="text-sm font-medium text-foreground">
                {t('pairHost.sasLabel')}
              </label>
              <Input
                id="remote-pair-sas"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                className="font-mono tracking-widest"
                value={sas}
                onChange={(event) => setSas(event.target.value.replace(/\D/g, '').slice(0, SAS_LENGTH))}
              />
              <p className="text-xs text-muted-foreground">{t('pairHost.sasHelp')}</p>
            </div>
            {attemptsLeft !== null && attemptsLeft > 0 && attemptsLeft < SAS_ATTEMPTS && (
              <p role="alert" className="text-sm text-destructive">
                {t('pairHost.attemptsLeft', { count: attemptsLeft })}
              </p>
            )}
            {confirmFailed && (
              <p role="alert" className="text-sm text-destructive">
                {t('pairHost.confirmFailed')}
              </p>
            )}
            <Button type="submit" disabled={sas.length !== SAS_LENGTH || isConfirming}>
              {isConfirming ? t('pairHost.sasChecking') : t('pairHost.sasConfirm')}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t('pairHost.waiting')}</p>
        )}
      </div>
    );
  }

  return (
    <RemoteModalFrame title={t('pairHost.title')} onClose={onClose}>
      {body}
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('pairHost.close')}
        </Button>
      </div>
    </RemoteModalFrame>
  );
}
