import { useTranslation } from 'react-i18next';

import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { ApiRequestError } from '@/shared/api';

type BundleErrorNoticeProps = {
  /** The failure of the last bundle request (anything thrown), or null when there is nothing to show. */
  error: unknown;
};

const BUNDLE_CODES = ['BUNDLE_VERSION_UNSUPPORTED', 'SNAPSHOT_NOT_FOUND'];

/** Reads `{ line, column, path }` out of the details of a BUNDLE_INVALID error; each part is optional. */
const readPosition = (details: unknown): { line?: number; column?: number; path?: string } => {
  if (!details || typeof details !== 'object') return {};
  const { line, column, path } = details as Record<string, unknown>;
  return {
    line: typeof line === 'number' ? line : undefined,
    column: typeof column === 'number' ? column : undefined,
    path: typeof path === 'string' && path ? path : undefined,
  };
};

/**
 * Shows a failed bundle request in place: a syntax error with its line, column and path, the bundle and snapshot codes in
 * plain words, anything else through the module's usual notice. Used by the import, export and restore dialogs.
 */
export function BundleErrorNotice({ error }: BundleErrorNoticeProps) {
  const { t } = useTranslation('agentProfiles');
  if (!error) return null;
  const code = error instanceof ApiRequestError ? error.code : undefined;

  if (code === 'BUNDLE_INVALID') {
    const { line, column, path } = readPosition((error as ApiRequestError).details);
    return (
      <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <p>{t('bundle.errors.BUNDLE_INVALID', { message: (error as ApiRequestError).message })}</p>
        {line !== undefined && column !== undefined && <p>{t('bundle.errors.position', { line, column })}</p>}
        {path && <p className="font-mono text-xs">{t('bundle.errors.path', { path })}</p>}
      </div>
    );
  }
  // The server says why a backup was refused (disk problem, or an unreadable stored file to repair first): its wording is the useful one.
  if (code === 'SNAPSHOT_UNAVAILABLE') {
    return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{(error as ApiRequestError).message}</div>;
  }
  if (code && BUNDLE_CODES.includes(code)) {
    return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{t(`bundle.errors.${code}`)}</div>;
  }
  return <ProfileErrorNotice error={error} />;
}
