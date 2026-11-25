import { useTranslation } from 'react-i18next';

import type { AgentProfileCorruptEntry } from '@/shared/types';

/**
 * Used by the agent-profiles panel to tell the user which stored template files could not be read (invalid JSON or
 * wrong shape). The server skips them in every list and never overwrites them, so this is where they are named.
 */
export function CorruptFilesNotice({ files }: { files: AgentProfileCorruptEntry[] }) {
  const { t } = useTranslation('agentProfiles');
  if (files.length === 0) return null;

  return (
    <div role="alert" className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
      <p className="font-medium">{t('corrupt.title', { count: files.length })}</p>
      <ul className="list-inside list-disc">
        {files.map((file) => <li key={file.id}>{t('corrupt.item', { id: file.id, error: file.error })}</li>)}
      </ul>
      <p className="text-muted-foreground">{t('corrupt.fix')}</p>
    </div>
  );
}
