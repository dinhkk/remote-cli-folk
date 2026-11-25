import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';

import { api, readApiJson, ApiRequestError } from '@/shared/api';
import { registerMfaReauth } from '@/shared/authToken';
import { Button, Input } from '@/shared/ui';

export default function MfaReauthDialog() {
  const { t } = useTranslation('auth');
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const resolve = useRef<((value: boolean) => void) | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const restoreObserver = useRef<MutationObserver | null>(null);
  const clearRestore = () => {
    restoreObserver.current?.disconnect(); restoreObserver.current = null;
  };
  const restoreFocus = () => {
    clearRestore();
    const target = previousFocus.current;
    if (!target?.isConnected) return;
    const attempt = () => {
      if (!target.isConnected) { clearRestore(); return; }
      if (target.matches(':disabled')) return;
      target.focus();
      clearRestore();
    };
    // The caller releases its busy state only after the reauth promise settles.
    restoreObserver.current = new MutationObserver(attempt);
    restoreObserver.current.observe(target, { attributes: true, attributeFilter: ['disabled'] });
    attempt();
  };
  const finish = (value: boolean) => {
    generation.current++; setBusy(false);
    resolve.current?.(value); resolve.current = null;
    setOpen(false); setCode(''); setError('');
    restoreFocus();
  };
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== document.body
        && !target.closest('[aria-labelledby="mfa-reauth-title"]')) lastFocused.current = target;
    };
    document.addEventListener('focusin', rememberFocus);
    const unregister = registerMfaReauth(() => new Promise<boolean>((done) => {
      clearRestore();
      previousFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement : lastFocused.current;
      resolve.current = done; setOpen(true); setError('');
    }));
    return () => { document.removeEventListener('focusin', rememberFocus); clearRestore(); unregister(); resolve.current?.(false); resolve.current = null; };
  }, []);
  if (!open) return null;
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="mfa-reauth-title" className="w-full max-w-sm space-y-4 rounded-xl border bg-background p-5 shadow-xl"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
        if (e.key !== 'Tab') return;
        const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), [tabindex="0"]')];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}
      onSubmit={(e) => { e.preventDefault(); if (busy) return; setBusy(true); setError('');
        const supplied = code, attempt = generation.current; setCode('');
        void api.auth.mfaReauth(supplied).then(readApiJson).then(() => { if (attempt === generation.current) finish(true); }).catch((caught: unknown) => {
          if (attempt !== generation.current) return;
          const details = caught instanceof ApiRequestError ? caught.details as { attemptsRemaining?: unknown } | undefined : undefined;
          const remaining = details?.attemptsRemaining;
          setError(typeof remaining === 'number' && Number.isInteger(remaining) && remaining >= 0 && remaining < 5
            ? t('security.attemptsRemaining', { count: remaining }) : t('security.failed'));
        }).finally(() => { if (attempt === generation.current) setBusy(false); });
      }}>
      <h2 id="mfa-reauth-title" className="font-semibold">{t('security.reauthTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('security.reauthHint')}</p>
      <label htmlFor="mfa-reauth-code" className="block text-sm">{t('security.code')}</label>
      <Input id="mfa-reauth-code" autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={busy}>{t('security.verify')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => finish(false)}>{t('security.cancel')}</Button></div>
    </form>
  </div>;
}
