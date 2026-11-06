import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { RemoteModalFrame } from '@/modules/remote/modals/RemoteModalFrame';
import { Button, Input } from '@/shared/ui';
import type { RemoteApiResult } from '@/shared/types';

type ReauthModalProps = {
  title: string;
  description?: string;
  /** Runs the sensitive action with the typed password. */
  submit: (password: string) => Promise<RemoteApiResult<unknown>>;
  /** Called with the outcome once it is not about the password: success, or a refusal for another reason. */
  onDone: (result: RemoteApiResult<unknown>) => void;
  onCancel: () => void;
};

/**
 * Asks for the account password again before a sensitive Remote action
 * (contracts.md section 2, endpoints marked `*`). The password goes straight to
 * `submit` and the field is emptied the moment it is sent, so it never stays in
 * the DOM. A wrong password (403 AUTH_INVALID_CREDENTIALS, or 401) or a lockout (429) keeps the prompt open with
 * an explanation; any other outcome is handed back to the caller.
 * Rendered by useReauthPrompt for the settings tab's panels.
 */
export function ReauthModal({ title, description, submit, onDone, onCancel }: ReauthModalProps) {
  const { t } = useTranslation('remote');
  const { isWrongPassword, isPasswordLockout } = useRemoteApi();
  // The password while it is being typed; emptied as soon as it is sent so it never lingers in the DOM.
  const [password, setPassword] = useState('');
  // True while the action runs, so a second press cannot send the password twice.
  const [isChecking, setIsChecking] = useState(false);
  // Why the last attempt did not go through, when the reason is the password itself.
  const [problem, setProblem] = useState<'wrong' | 'locked' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (password === '' || isChecking) return;
    const sent = password;
    setPassword('');
    setProblem(null);
    setIsChecking(true);
    const result = await submit(sent);
    setIsChecking(false);
    if (isWrongPassword(result)) {
      setProblem('wrong');
      inputRef.current?.focus();
    } else if (isPasswordLockout(result)) {
      setProblem('locked');
    } else {
      onDone(result);
    }
  };

  return (
    <RemoteModalFrame title={title} onClose={onCancel}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        <div className="space-y-1.5">
          <label htmlFor="remote-reauth-password" className="text-sm font-medium text-foreground">
            {t('reauth.passwordLabel')}
          </label>
          <Input
            id="remote-reauth-password"
            ref={inputRef}
            name="account-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {problem === 'wrong' && (
            <p role="alert" className="text-sm text-destructive">
              {t('reauth.wrongPassword')}
            </p>
          )}
          {problem === 'locked' && (
            <p role="alert" className="text-sm text-destructive">
              {t('reauth.locked')}
            </p>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('reauth.cancel')}
          </Button>
          <Button type="submit" disabled={password === '' || isChecking}>
            {isChecking ? t('reauth.checking') : t('reauth.confirm')}
          </Button>
        </div>
      </form>
    </RemoteModalFrame>
  );
}
