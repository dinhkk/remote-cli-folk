import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RemoteMasterKeySource } from '@/shared/types';

// FR-31: tool approvals shorter than this expire before someone answering from a Controller can react.
const RECOMMENDED_APPROVAL_TIMEOUT_MS = 300_000;

type RemoteWarningsPanelProps = {
  /** Null while the relay settings have not loaded. */
  masterKeySource: RemoteMasterKeySource | null;
  masterKeyMismatch: boolean;
  unsupportedMode: boolean;
  /** Null when the server did not report it. */
  approvalTimeoutMs: number | null;
};

/**
 * The warnings of the Remote work screen: a master key that is only a file or
 * that changed (FR-41), a tool-approval timeout under five minutes (FR-31), and
 * a server mode where Remote cannot run. Renders nothing when all is well.
 * Rendered by RemoteSettingsTab.
 */
export function RemoteWarningsPanel({
  masterKeySource,
  masterKeyMismatch,
  unsupportedMode,
  approvalTimeoutMs,
}: RemoteWarningsPanelProps) {
  const { t } = useTranslation('remote');

  const messages: string[] = [];
  if (masterKeyMismatch) messages.push(t('warnings.masterKeyMismatch'));
  else if (masterKeySource === 'file') messages.push(t('warnings.masterKeyFile'));
  if (unsupportedMode) messages.push(t('warnings.unsupportedMode'));
  if (approvalTimeoutMs !== null && approvalTimeoutMs < RECOMMENDED_APPROVAL_TIMEOUT_MS) {
    const wholeMinutes = approvalTimeoutMs >= 60_000 && approvalTimeoutMs % 60_000 === 0;
    const duration = wholeMinutes
      ? t('warnings.duration.minutes', { count: approvalTimeoutMs / 60_000 })
      : t('warnings.duration.seconds', { count: Math.round(approvalTimeoutMs / 1000) });
    messages.push(t('warnings.approvalTimeout', { duration }));
  }

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {messages.map((message) => (
        <div
          key={message}
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">{message}</p>
        </div>
      ))}
    </div>
  );
}
