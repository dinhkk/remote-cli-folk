import { useTranslation } from 'react-i18next';
import { useState } from 'react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';
import { Button, Input } from '@/shared/ui';

export default function MfaLoginForm() {
  const { t } = useTranslation('auth');
  const { verifyMfa, cancelMfa } = useAuth();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AuthScreenLayout title={t('security.title')} description={t('security.loginHint')} footerText="">
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (busy) return; setBusy(true); setError('');
      const supplied = code; setCode('');
      void verifyMfa(supplied, recovery).then((result) => { if (!result.success) setError(t('security.failed')); }).finally(() => setBusy(false));
    }}>
      <label htmlFor="mfa-login-code">{recovery ? t('security.recovery') : t('security.code')}</label>
      <Input id="mfa-login-code" autoFocus autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 32 : 6} pattern={recovery ? '[a-fA-F0-9]{32}' : '[0-9]{6}'} required value={code} onChange={(e) => setCode(e.target.value.trim())} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{t('security.verify')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }}>{recovery ? t('security.useAuthenticator') : t('security.useRecovery')}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={cancelMfa}>{t('security.back')}</Button>
    </form>
  </AuthScreenLayout>;
}
