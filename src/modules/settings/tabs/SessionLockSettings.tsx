import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { lockAuthSession } from '@/shared/authToken';
import { Button } from '@/shared/ui';

export default function SessionLockSettings() {
  const [autoLock, setAutoLock] = useState<boolean | null>(null);
  const [idleHours, setIdleHours] = useState(24);
  const [draftHours, setDraftHours] = useState('24');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.auth.sessionStatus().then(readApiJson<{ autoLock: boolean; idleHours?: number }>).then(data => {
      if (active && typeof data.autoLock === 'boolean') {
        setAutoLock(data.autoLock);
        setIdleHours(data.idleHours ?? 24);
        setDraftHours(String(data.idleHours ?? 24));
      }
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
      Automatically lock after {idleHours} hours without web activity
    </label>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
      event.preventDefault();
      const hours = Number(draftHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) return;
      void run(async () => {
        const result = await readApiJson<{ idleHours: number }>(await api.auth.setIdleLockHours(hours));
        setIdleHours(result.idleHours); setDraftHours(String(result.idleHours));
      });
    }}>
      <label className="flex flex-col gap-1">Hours before automatic lock
        <input type="number" min={1} max={168} step={1} required value={draftHours}
          disabled={busy || autoLock === null} onChange={event => setDraftHours(event.target.value)}
          className="w-24 rounded border bg-background px-2 py-1" />
      </label>
      <Button type="submit" variant="outline" disabled={busy || autoLock === null
        || !Number.isInteger(Number(draftHours)) || Number(draftHours) < 1 || Number(draftHours) > 168
        || Number(draftHours) === idleHours}>Save hours</Button>
    </form>
    <p className="text-sm text-muted-foreground">Increasing the hours requires recent authenticator verification.</p>
    <p className="text-sm text-muted-foreground">Turning this off requires recent authenticator verification.</p>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void run(async () => {
      await readApiJson(await api.auth.lock()); lockAuthSession();
    })}>Lock now</Button>
  </section>;
}
