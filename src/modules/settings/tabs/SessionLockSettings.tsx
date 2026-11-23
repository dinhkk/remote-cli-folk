import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { lockAuthSession } from '@/shared/authToken';
import { Button } from '@/shared/ui';

export default function SessionLockSettings() {
  const [autoLock, setAutoLock] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.auth.sessionStatus().then(readApiJson<{ autoLock: boolean }>).then(data => {
      if (active && typeof data.autoLock === 'boolean') setAutoLock(data.autoLock);
    }).catch(() => { if (active) setError('Unable to load session lock settings.'); });
    return () => { active = false; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch { setError('Unable to change session lock settings. Try again.'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 border-t pt-4" aria-labelledby="session-lock-settings-title">
    <h3 id="session-lock-settings-title" className="font-medium">Session lock</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={autoLock === true} disabled={busy || autoLock === null}
        onChange={event => {
          const enabled = event.target.checked;
          void run(async () => {
            const result = await readApiJson<{ autoLock: boolean }>(await api.auth.setAutoLock(enabled));
            setAutoLock(result.autoLock);
          });
        }} />
      Automatically lock after 24 hours without web activity
    </label>
    <p className="text-sm text-muted-foreground">Turning this off requires recent authenticator verification.</p>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void run(async () => {
      await readApiJson(await api.auth.lock()); lockAuthSession();
    })}>Lock now</Button>
  </section>;
}
