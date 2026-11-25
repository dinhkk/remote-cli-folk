import { Lock, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { lockAuthSession } from '@/shared/authToken';
import { Button } from '@/shared/ui';
import { isTargetMode } from '@/shared/transport/target-context';
import { MFA_STATUS_CHANGED_EVENT } from '@/modules/auth/mfa-status-event';

/** Locks the browser session through the existing server gate, never just the UI. */
export default function QuickSessionLockButton() {
  const { t } = useTranslation('auth');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (isTargetMode()) return;
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const data = await readApiJson<{ enabled: boolean }>(await api.auth.mfaStatus());
        if (active && current === revision) setEnabled(data.enabled === true);
      } catch {
        if (active && current === revision) setEnabled(false);
      }
    };
    const onRefresh = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') onRefresh(); };
    onRefresh();
    window.addEventListener('focus', onRefresh);
    window.addEventListener(MFA_STATUS_CHANGED_EVENT, onRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener(MFA_STATUS_CHANGED_EVENT, onRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!failed) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setFailed(false); };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [failed]);

  const lock = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await readApiJson(await api.auth.lock());
      lockAuthSession();
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (!enabled || isTargetMode()) return null;
  return <div className="relative shrink-0">
    <Button type="button" variant="ghost" size="icon" disabled={busy} aria-busy={busy}
      aria-label={t('quickLock.label')} title={t('quickLock.label')}
      onClick={() => { void lock(); }}>
      <Lock aria-hidden="true" />
    </Button>
    {failed && <div role="alert" className="absolute right-0 top-full z-50 w-64 rounded-md border bg-background p-3 text-sm text-destructive shadow-md">
      <button type="button" aria-label={t('passwordWeak.dismiss')} className="float-right ml-2 rounded p-1 focus-visible:outline" onClick={() => setFailed(false)}><X className="h-4 w-4" aria-hidden="true" /></button>
      {t('quickLock.error')}
    </div>}
  </div>;
}
