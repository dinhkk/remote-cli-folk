import { useTranslation } from 'react-i18next';

import { ApiRequestError } from '@/shared/api';
import { Button } from '@/shared/ui';

type ProfileErrorNoticeProps = {
  /** The failure of the last request (anything thrown), or null when there is nothing to show. */
  error: unknown;
  /** Offered on a stale-write conflict: reload the latest records (and usually close the form). */
  onReload?: () => void;
};

// Codes whose cause and fix the notice explains in its own words; anything else shows the server's message.
const KNOWN_CODES = ['PROFILE_STALE', 'SLUG_TAKEN', 'DIRECTORY_NOT_FOUND', 'DIRECTORY_NOT_A_DIRECTORY', 'PROFILE_CORRUPT', 'BLOCK_NAME_TAKEN', 'BLOCK_LIMIT_REACHED', 'BLOCK_CONTENT_LIMIT_REACHED', 'BLOCK_CONTENT_EXISTS'];

/**
 * Used by every list and form of the agent-profiles module to show a failed request next to the place
 * that caused it: what went wrong, how to fix it, and a reload button when a newer edit made the save stale.
 */
export function ProfileErrorNotice({ error, onReload }: ProfileErrorNoticeProps) {
  const { t } = useTranslation('agentProfiles');
  if (!error) return null;

  const apiError = error instanceof ApiRequestError ? error : null;
  const code = apiError?.code && KNOWN_CODES.includes(apiError.code) ? apiError.code : null;
  const message = code ? t(`errors.${code}`) : (error instanceof Error && error.message) || t('errors.unknown');

  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <p>{message}</p>
      {code === 'PROFILE_STALE' && onReload && (
        <Button type="button" size="sm" variant="outline" onClick={onReload}>{t('errors.reload')}</Button>
      )}
    </div>
  );
}
