import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import SessionLockSettings from '@/modules/settings/tabs/SessionLockSettings';
import { api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { isTargetMode } from '@/shared/transport/target-context';

type Enrollment = { secret: string; uri: string; expiresAt: number };
function EnrollmentQr({ uri }: { uri: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active = true;
    void QRCode.toCanvas(element, uri, { width: 240, margin: 4, errorCorrectionLevel: 'M' }).catch(() => { if (active) setError(true); });
    return () => { active = false; element.getContext('2d')?.clearRect(0, 0, element.width, element.height); };
  }, [uri]);
  return <>{error && <p role="alert">QR unavailable. Enter the setup key manually.</p>}<canvas ref={canvas} aria-label="Authenticator setup QR code" className="max-w-full" /></>;
}

/** Enrollment and recovery material is held only while this settings view is open. */
export default function TotpSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (isTargetMode()) return;
    let active = true;
    void api.auth.mfaStatus().then(readApiJson<{ enabled: boolean }>).then((d) => { if (active) setEnabled(d.enabled); })
      .catch(() => { if (active) setError('Unable to load two-factor settings.'); });
    return () => { active = false; };
  }, []);
  if (isTargetMode()) return null;
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch { setError('Action failed. Check your password or code and try again later.'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-xl border border-border p-4" aria-labelledby="totp-title">
    <h2 id="totp-title" className="text-lg font-semibold">Two-factor authentication (TOTP)</h2>
    <p className="text-sm text-muted-foreground">{enabled === null ? 'Loading…' : enabled ? 'Enabled. New sign-ins require your authenticator.' : 'Disabled. Enable it to protect new sign-ins.'}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {codes.length > 0 && <div className="space-y-3">
      <p>Save these 10 recovery codes in a safe place. Each works once. They will not be shown again.</p>
      <ul className="space-y-1 break-all font-mono text-xs">{codes.map((item) => <li key={item}>{item}</li>)}</ul>
      <Button onClick={() => setCodes([])}>I saved my recovery codes</Button>
    </div>}
    {enrollment ? <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const supplied = code; setCode('');
      const result = await readApiJson<{ recoveryCodes: string[] }>(await api.auth.mfaActivate(supplied));
      setCodes(result.recoveryCodes); setEnrollment(null); setEnabled(true);
    }); }}>
      <EnrollmentQr uri={enrollment.uri} />
      <p className="break-all text-sm">Setup key: <code>{enrollment.secret}</code></p>
      <p className="text-sm">Valid until {new Date(enrollment.expiresAt).toLocaleTimeString()}. Scan it, then enter a code.</p>
      <label htmlFor="totp-activate-code" className="block">Authenticator code</label>
      <Input id="totp-activate-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
      <Button type="submit" disabled={busy}>Activate</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setEnrollment(null); setCode(''); }}>Cancel setup</Button>
    </form> : <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const supplied = password; setPassword(''); setCodes([]);
      setEnrollment(await readApiJson<Enrollment>(await api.auth.mfaEnroll(supplied)));
    }); }}>
      <label htmlFor="totp-password" className="block text-sm">Current password</label>
      <Input id="totp-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" disabled={busy || enabled === null}>{enabled ? 'Replace authenticator' : 'Set up authenticator'}</Button>
    </form>}
    {enabled && <SessionLockSettings />}
    {enabled && <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
        const result = await readApiJson<{ recoveryCodes: string[] }>(await api.auth.mfaRecoveryCodes()); setCodes(result.recoveryCodes);
      })}>Replace recovery codes</Button>
      <Button variant="destructive" disabled={busy} onClick={() => void run(async () => {
        await readApiJson(await api.auth.mfaDisable()); setEnabled(false); setCodes([]); setEnrollment(null);
        setNotice('Two-factor authentication disabled. Other devices have been signed out.');
      })}>Disable TOTP</Button>
    </div>}
    <form className="space-y-3 border-t pt-4" onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const old = password, next = newPassword; setPassword(''); setNewPassword('');
      await readApiJson(await api.auth.changePassword(old, next));
      setNotice('Password changed. Other devices have been signed out.');
    }); }}>
      <h3 className="font-medium">Change password</h3>
      <label htmlFor="change-current-password" className="block text-sm">Current password</label>
      <Input id="change-current-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <label htmlFor="change-new-password" className="block text-sm">New password (at least 12 characters)</label>
      <Input id="change-new-password" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      <Button type="submit" disabled={busy || enabled === null}>Change password</Button>
    </form>
  </section>;
}
