import { useTranslation } from 'react-i18next';

import { UnverifiedDeviceName } from '@/modules/remote/components/UnverifiedDeviceName';
import { AUDIT_EVENTS, AUDIT_NEGATIVE_RESULTS, AUDIT_RESULTS } from '@/modules/remote/utils/audit-vocabulary';
import { formatRemoteTime } from '@/modules/remote/utils/format-remote-time';
import { extractAuditChanges, summarizeAuditDetail } from '@/modules/remote/utils/summarize-audit-detail';
import type { RemoteAuditEntry } from '@/shared/types';

/**
 * One line of the Host audit log: when, which Controller (always marked
 * unverified), what happened, to what, how it ended and a one-line detail.
 * Every string is a React text node; they come from a possibly hostile Controller.
 * Used by AuditPanel.
 */
export function AuditEntryRow({ entry }: { entry: RemoteAuditEntry }) {
  const { t } = useTranslation('remote');
  const time = formatRemoteTime(entry.at);
  const detail = summarizeAuditDetail(entry.detail);
  const changes = extractAuditChanges(entry.detail);
  // A word outside the known vocabulary is shown as sent, never used to build a translation key.
  const event = AUDIT_EVENTS.includes(entry.event) ? t(`audit.event.${entry.event}`) : entry.event;
  const result = AUDIT_RESULTS.includes(entry.result) ? t(`audit.result.${entry.result}`) : entry.result;
  const resultTone = AUDIT_NEGATIVE_RESULTS.has(entry.result) ? 'text-destructive' : 'text-muted-foreground';

  return (
    <li className="space-y-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {time && <span className="text-xs text-muted-foreground">{time}</span>}
        <UnverifiedDeviceName name={entry.controller} />
        <span className="text-sm font-medium text-foreground">{event}</span>
        <span className={`text-xs ${resultTone}`}>{result}</span>
      </div>
      {entry.target !== '' && <p className="break-all text-sm text-foreground">{entry.target}</p>}
      {detail !== '' && <p className="break-all text-xs text-muted-foreground">{detail}</p>}
      {changes.map((change) => (
        <div key={change.field} className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5">
          <p className="text-xs font-semibold text-destructive">
            {t(`audit.changed.${change.field}`)}
            {change.fromLength !== null && change.toLength !== null && ` ${t('audit.changed.lengths', { from: change.fromLength, to: change.toLength })}`}
          </p>
          <p className="break-all font-mono text-xs text-foreground">{change.value}</p>
        </div>
      ))}
    </li>
  );
}
