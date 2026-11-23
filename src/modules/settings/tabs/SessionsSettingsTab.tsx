import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import { expireAuthSession } from '@/shared/authToken';
import { Button, Input } from '@/shared/ui';
import { isTargetMode } from '@/shared/transport/target-context';

type DeviceSession = {
  id: string; browser: string; createdAt: number; lastSeenAt: number;
  expiresAt: number; current: boolean;
};

/** Session secrets never reach this view; the API returns public device identifiers only. */
export default function SessionsSettingsTab() {
  const { t } = useTranslation('settings');
  const { logout } = useAuth();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (isTargetMode()) return;
    const data = await readApiJson<{ sessions: DeviceSession[] }>(await api.auth.sessions());
    setSessions(data.sessions);
  }, []);
  useEffect(() => { void refresh().catch(() => setError(t('sessions.error'))); }, [refresh, t]);
  if (isTargetMode()) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch { setError(t('sessions.error')); }
    finally { setBusy(false); }
  };

  return <section className="space-y-5">
    <div>
      <h2 className="text-lg font-semibold">{t('sessions.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('sessions.description')}</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={busy} onClick={() => void run(logout)}>{t('sessions.logout')}</Button>
    <ul className="divide-y rounded-xl border border-border">
      {sessions.map((session) => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{session.browser}{session.current ? ` · ${t('sessions.current')}` : ''}</p>
          <p className="text-muted-foreground">{t('sessions.lastSeen')}: {new Date(session.lastSeenAt).toLocaleString()}</p>
          <p className="text-muted-foreground">{t('sessions.expires')}: {new Date(session.expiresAt).toLocaleString()}</p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
          await readApiJson(await api.auth.revokeSession(session.id));
          if (session.current) expireAuthSession();
          else await refresh();
        })}>{t('sessions.revoke')}</Button>
      </li>)}
    </ul>
    <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const supplied = password;
        setPassword('');
        await readApiJson(await api.auth.logoutAll(supplied));
        expireAuthSession();
      });
    }}>
      <label htmlFor="sessions-password" className="block text-sm font-medium">{t('sessions.password')}</label>
      <Input id="sessions-password" type="password" autoComplete="current-password" required value={password}
        onChange={(event) => setPassword(event.target.value)} />
      <Button type="submit" variant="destructive" disabled={busy || !password}>{t('sessions.logoutAll')}</Button>
    </form>
  </section>;
}
