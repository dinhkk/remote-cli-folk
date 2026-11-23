import { useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { registerMfaReauth } from '@/shared/authToken';
import { Button, Input } from '@/shared/ui';

export default function MfaReauthDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resolve = useRef<((value: boolean) => void) | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const finish = (value: boolean) => {
    resolve.current?.(value); resolve.current = null;
    setOpen(false); setCode(''); setError('');
    previousFocus.current?.focus();
  };
  useEffect(() => {
    const unregister = registerMfaReauth(() => new Promise<boolean>((done) => {
      previousFocus.current = document.activeElement as HTMLElement | null;
      resolve.current = done; setOpen(true); setError('');
    }));
    return () => { unregister(); resolve.current?.(false); resolve.current = null; };
  }, []);
  if (!open) return null;
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="mfa-reauth-title" className="w-full max-w-sm space-y-4 rounded-xl border bg-background p-5 shadow-xl"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) finish(false); }}
      onSubmit={(e) => { e.preventDefault(); if (busy) return; setBusy(true); setError('');
        const supplied = code; setCode('');
        void api.auth.mfaReauth(supplied).then(readApiJson).then(() => finish(true)).catch(() => setError('Verification failed. Check the code or try again later.')).finally(() => setBusy(false));
      }}>
      <h2 id="mfa-reauth-title" className="font-semibold">Verify sensitive action</h2>
      <p className="text-sm text-muted-foreground">Enter a new code from your authenticator. Verification lasts 10 minutes.</p>
      <label htmlFor="mfa-reauth-code" className="block text-sm">Authenticator code</label>
      <Input id="mfa-reauth-code" autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Verify</Button><Button type="button" variant="outline" disabled={busy} onClick={() => finish(false)}>Cancel</Button></div>
    </form>
  </div>;
}
