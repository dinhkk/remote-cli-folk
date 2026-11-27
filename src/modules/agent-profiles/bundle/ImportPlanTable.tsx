import { useTranslation } from 'react-i18next';

import { codeKey, sensitiveReasonKey } from '@/modules/agent-profiles/bundle/bundle-helpers';
import { Badge, Button } from '@/shared/ui';
import type { ImportPlan, ImportPlanItem, ImportProblem, ImportStatus } from '@/shared/types';

type ImportPlanTableProps = {
  plan: ImportPlan;
  /** Keys (items and folder rows) ticked for overwrite. */
  overwrite: ReadonlySet<string>;
  /** Keys of the sensitive items the user accepted. */
  acceptSensitive: ReadonlySet<string>;
  onToggleOverwrite: (key: string) => void;
  onToggleSensitive: (key: string) => void;
  onSelectAllSensitive: () => void;
  /** True after an apply: the ticks are frozen until the next preview. */
  locked: boolean;
};

const STATUS_VARIANT: Record<ImportStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  new: 'default',
  identical: 'secondary',
  conflict: 'outline',
  invalid: 'destructive',
  skipped: 'secondary',
};

function ProblemLine({ problem }: { problem: ImportProblem }) {
  const { t } = useTranslation('agentProfiles');
  return (
    <li className={problem.level === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}>
      <span className="font-medium">{t(`bundle.import.problemLevel.${problem.level}`)}:</span> {problem.message}
      {problem.line !== undefined && problem.column !== undefined && (
        <span className="text-muted-foreground"> ({t('bundle.import.position', { line: problem.line, column: problem.column })})</span>
      )}
      {problem.path && <span className="font-mono text-xs text-muted-foreground"> {problem.path}</span>}
    </li>
  );
}

type OverwriteBoxProps = { label: string; checked: boolean; disabled: boolean; onChange: () => void };

function OverwriteBox({ label, checked, disabled, onChange }: OverwriteBoxProps) {
  return (
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} className="h-4 w-4" />
  );
}

/**
 * The preview of an import as a table: one row per template or block with its status, wording of its code, problems with
 * their line and column, sensitive badge with its own tick, and an overwrite tick for a conflict (disabled, with the
 * reason, when it can never be overwritten). A project block is followed by one row per folder text. Nothing is ticked by
 * default. Used by the import dialog.
 */
export function ImportPlanTable({ plan, overwrite, acceptSensitive, onToggleOverwrite, onToggleSensitive, onSelectAllSensitive, locked }: ImportPlanTableProps) {
  const { t } = useTranslation('agentProfiles');
  const hasSensitive = plan.items.some((item) => item.sensitive.length > 0);
  const wording = (code: string | undefined, reason?: string): string | null => {
    const key = codeKey(code);
    return key ? t(key) : (reason ?? null);
  };

  const renderItem = (item: ImportPlanItem) => (
    <tr key={item.key} className="align-top">
      <td className="py-2 pr-3">
        <span className="font-medium">{item.label}</span>
        <Badge variant="outline" className="ml-2">{t(`bundle.import.kind.${item.kind}`)}</Badge>
      </td>
      <td className="py-2 pr-3"><Badge variant={STATUS_VARIANT[item.status]}>{t(`bundle.import.status.${item.status}`)}</Badge></td>
      <td className="space-y-1 py-2 text-sm">
        {wording(item.code) && <p className="text-muted-foreground">{wording(item.code)}</p>}
        {item.problems.length > 0 && <ul className="space-y-0.5">{item.problems.map((problem, index) => <ProblemLine key={`${problem.code}-${index}`} problem={problem} />)}</ul>}
        {item.sensitive.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="destructive">{t('bundle.import.sensitiveBadge')}</Badge>
            <span className="text-xs">{item.sensitive.map((reason) => {
              const { key, values } = sensitiveReasonKey(reason);
              return t(key, { ...values, defaultValue: reason });
            }).join(', ')}</span>
            <OverwriteBox
              label={t('bundle.import.sensitiveAllow', { name: item.label })}
              checked={acceptSensitive.has(item.key)}
              disabled={locked}
              onChange={() => onToggleSensitive(item.key)}
            />
          </div>
        )}
        {item.status === 'conflict' && (
          <label className="flex items-center gap-2">
            <OverwriteBox
              label={t('bundle.import.overwrite', { name: item.label })}
              checked={overwrite.has(item.key)}
              disabled={locked || !item.overwritable}
              onChange={() => onToggleOverwrite(item.key)}
            />
            <span aria-hidden="true">{t('bundle.import.overwriteShort')}</span>
          </label>
        )}
      </td>
    </tr>
  );

  const renderFolders = (item: ImportPlanItem) => (item.folders ?? []).map((folder) => (
    <tr key={folder.key} className="align-top text-sm">
      <td className="py-1 pl-6 pr-3 font-mono text-xs">{t('bundle.import.folderLabel', { directory: folder.sourceDirectory })}</td>
      <td className="py-1 pr-3"><Badge variant={STATUS_VARIANT[folder.status]}>{t(`bundle.import.status.${folder.status}`)}</Badge></td>
      <td className="space-y-1 py-1">
        {wording(folder.code, folder.reason) && <p className="text-muted-foreground">{wording(folder.code, folder.reason)}</p>}
        {folder.status === 'conflict' && (
          <OverwriteBox
            label={t('bundle.import.overwriteFolder', { directory: folder.sourceDirectory, name: item.label })}
            checked={overwrite.has(folder.key)}
            disabled={locked || !folder.overwritable}
            onChange={() => onToggleOverwrite(folder.key)}
          />
        )}
      </td>
    </tr>
  ));

  return (
    <div className="space-y-2">
      {hasSensitive && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
          <p className="min-w-0 flex-1 text-muted-foreground">{t('bundle.import.sensitiveHint')}</p>
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onSelectAllSensitive}>{t('bundle.import.selectAllSensitive')}</Button>
        </div>
      )}
      <table aria-label={t('bundle.import.tableLabel')} className="w-full text-left">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="pb-1 pr-3 font-medium">{t('bundle.import.columns.item')}</th>
            <th scope="col" className="pb-1 pr-3 font-medium">{t('bundle.import.columns.status')}</th>
            <th scope="col" className="pb-1 font-medium">{t('bundle.import.columns.details')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {plan.items.flatMap((item) => [renderItem(item), ...renderFolders(item)])}
        </tbody>
      </table>
    </div>
  );
}
