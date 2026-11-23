import { useState } from 'react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import { Button, Input } from '@/shared/ui';

export default function SessionLockScreen() {
  const { unlock, logout } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="flex min-h-screen items-center justify-center bg-background p-4">
    <form className="w-full max-w-sm space-y-4 rounded-xl border p-5" aria-labelledby="session-lock-title"
      onSubmit={event => {
        event.preventDefault();
        if (busy) return;
        setBusy(true); setError('');
        const supplied = code; setCode('');
        void unlock(supplied).then(result => { if (!result.success) setError(result.error); }).finally(() => setBusy(false));
      }}>
      <h1 id="session-lock-title" className="text-xl font-semibold">Session locked</h1>
      <p className="text-sm text-muted-foreground">Enter a code from your authenticator to continue.</p>
      <label htmlFor="session-unlock-code" className="block text-sm">Authenticator code</label>
      <Input id="session-unlock-code" autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>Unlock</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => { void logout(); }}>Sign out</Button>
      </div>
    </form>
  </main>;
}
