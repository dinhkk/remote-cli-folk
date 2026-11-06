import { useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useReauthPrompt } from '@/modules/remote/hooks/useReauthPrompt';
import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { Button, Input, PASSWORD_MANAGER_IGNORE } from '@/shared/ui';
import type { RemoteRelayConfig } from '@/shared/types';

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Same floor the server enforces on `PUT /api/remote/relay-config` (INVALID_RELAY_SECRET). */
const MIN_RELAY_SECRET_LENGTH = 32;

// A relay address must be secure (wss/https); plain ws/http is accepted only for a relay on this machine, for development.
const isValidRelayUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.hostname === '') return false;
    return url.protocol === 'wss:' || url.protocol === 'https:' || ((url.protocol === 'ws:' || url.protocol === 'http:') && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
};

type RelayConfigPanelProps = {
  config: RemoteRelayConfig;
  /** Called after the relay was saved, so the screen reloads what the server now holds. */
  onSaved: () => void;
};

/**
 * Form for the relay address and its shared secret (FR-4, FR-5). The secret is typed
 * once into a masked field and sent with the account password; the server never
 * returns it, so the field can only ever be empty, and it is emptied again as soon
 * as the save succeeded. Changing an already configured relay revokes every
 * pairing, which the form says before it is submitted. Rendered by RemoteSettingsTab.
 */
export function RelayConfigPanel({ config, onSaved }: RelayConfigPanelProps) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  const { requestReauth, reauthModal } = useReauthPrompt();
  // The address being edited; starts from what the server holds.
  const [url, setUrl] = useState(config.url);
  // The secret being typed; never prefilled and emptied once it was sent.
  const [secret, setSecret] = useState('');
  // The reason the last save attempt did not go out or did not succeed, as a translation key.
  const [problem, setProblem] = useState<'invalidUrl' | 'secretRequired' | 'secretTooShort' | 'failed' | null>(null);
  // What the server said when the save was refused (its message, else its error code), shown under the generic line.
  const [reason, setReason] = useState<string | null>(null);
  // Shows "Relay saved." after a successful save until the next edit.
  const [justSaved, setJustSaved] = useState(false);
  // Blocks a second save while the first waits for the password or the server.
  const [isSaving, setIsSaving] = useState(false);

  const isConfigured = config.url !== '' || config.hasSecret;
  const isChanging = isConfigured && (url.trim() !== config.url || (config.hasSecret && secret !== ''));

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!isValidRelayUrl(trimmed)) {
      setProblem('invalidUrl');
      return;
    }
    if (secret === '') {
      setProblem('secretRequired');
      return;
    }
    // The server refuses anything shorter (a short secret can be brute-forced from one gate URL), so say so before asking for the password.
    if (secret.length < MIN_RELAY_SECRET_LENGTH) {
      setProblem('secretTooShort');
      return;
    }
    setProblem(null);
    setReason(null);
    setJustSaved(false);
    setIsSaving(true);
    const result = await requestReauth({
      title: t('relay.reauthTitle'),
      description: t('relay.reauthDescription'),
      run: (password) => remote.saveRelayConfig(trimmed, secret, password),
    });
    setIsSaving(false);
    if (result === null) return;
    if (result.ok) {
      setSecret('');
      setJustSaved(true);
      onSaved();
    } else {
      setProblem('failed');
      setReason(result.message ?? result.code ?? (result.status > 0 ? `HTTP ${result.status}` : null));
    }
  };

  const edit = (apply: () => void) => {
    apply();
    setProblem(null);
    setJustSaved(false);
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{t('relay.title')}</h4>
        <p className="mt-1 text-sm text-muted-foreground">{t('relay.description')}</p>
      </div>

      <form onSubmit={handleSave} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="remote-relay-url" className="text-sm font-medium text-foreground">
            {t('relay.urlLabel')}
          </label>
          <Input
            id="remote-relay-url"
            name="relay-endpoint"
            type="url"
            inputMode="url"
            autoComplete="off"
            {...PASSWORD_MANAGER_IGNORE}
            spellCheck={false}
            placeholder={t('relay.urlPlaceholder')}
            value={url}
            onChange={(event) => edit(() => setUrl(event.target.value))}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="remote-relay-secret" className="text-sm font-medium text-foreground">
            {t('relay.secretLabel')}
          </label>
          <Input
            id="remote-relay-secret"
            name="relay-access-key"
            type="password"
            autoComplete="new-password"
            {...PASSWORD_MANAGER_IGNORE}
            placeholder={t('relay.secretPlaceholder')}
            value={secret}
            onChange={(event) => edit(() => setSecret(event.target.value))}
          />
          {config.hasSecret && <p className="text-xs text-muted-foreground">{t('relay.secretStored')}</p>}
        </div>

        {isChanging && (
          <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('relay.changeWarning')}</span>
          </p>
        )}
        {problem && (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>{t(`relay.${problem}`)}</p>
            {problem === 'failed' && reason && <p className="text-xs">{reason}</p>}
          </div>
        )}
        {justSaved && <p className="text-sm text-emerald-600 dark:text-emerald-400">{t('relay.saved')}</p>}

        <Button type="submit" disabled={isSaving}>
          {isSaving ? t('relay.saving') : t('relay.save')}
        </Button>
      </form>
      {reauthModal}
    </section>
  );
}
