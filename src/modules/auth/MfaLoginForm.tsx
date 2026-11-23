import { useState } from 'react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';
import { Button, Input } from '@/shared/ui';

export default function MfaLoginForm() {
  const { verifyMfa, cancelMfa } = useAuth();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AuthScreenLayout title="Two-factor authentication" description="Complete sign-in with your authenticator or a recovery code." footerText="">
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (busy) return; setBusy(true); setError('');
      const supplied = code; setCode('');
      void verifyMfa(supplied, recovery).then((result) => { if (!result.success) setError(result.error); }).finally(() => setBusy(false));
    }}>
      <label htmlFor="mfa-login-code">{recovery ? 'Recovery code' : 'Authenticator code'}</label>
      <Input id="mfa-login-code" autoFocus autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 32 : 6} pattern={recovery ? '[a-fA-F0-9]{32}' : '[0-9]{6}'} required value={code} onChange={(e) => setCode(e.target.value.trim())} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>Verify</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }}>{recovery ? 'Use authenticator' : 'Use recovery code'}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={cancelMfa}>Back to sign-in</Button>
    </form>
  </AuthScreenLayout>;
}
