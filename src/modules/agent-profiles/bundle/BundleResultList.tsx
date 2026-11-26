import { useTranslation } from 'react-i18next';

import { codeKey } from '@/modules/agent-profiles/bundle/bundle-helpers';
import type { ImportResult } from '@/shared/types';

type BundleResultListProps = {
  /** What an import or a restore did. */
  result: ImportResult;
};

/** `template:alpha` -> `alpha`; `block:alpha#k1` -> `alpha#k1`. */
const nameOfKey = (key: string): string => key.slice(key.indexOf(':') + 1);

/**
 * The outcome of an apply or restore: a warning when it was only partly applied, the name of the backup taken first,
 * and one line per item (and per folder entry) with its status and reason. Used by the import and restore dialogs.
 */
export function BundleResultList({ result }: BundleResultListProps) {
  const { t } = useTranslation('agentProfiles');
  const wording = (code?: string, reason?: string): string => {
    const key = codeKey(code);
    return key ? t(key) : (reason ?? code ?? '');
  };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('bundle.result.title')}</h3>
      {result.partial && (
        <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{t('bundle.result.partialWarning')}</div>
      )}
      {result.snapshot && <p className="text-sm text-muted-foreground">{t('bundle.result.snapshot', { name: result.snapshot })}</p>}
      <ul aria-label={t('bundle.result.list')} className="space-y-1 text-sm">
        {result.items.map((item) => (
          <li key={item.key}>
            <span className="font-medium">{nameOfKey(item.key)}</span>: {t(`bundle.result.${item.status}`)}
            {(item.code || item.reason) && <span className="text-muted-foreground"> ({wording(item.code, item.reason)})</span>}
            {item.folders && item.folders.length > 0 && (
              <ul className="ml-4 list-disc">
                {item.folders.map((folder) => (
                  <li key={folder.key}>
                    {nameOfKey(folder.key)}: {t(`bundle.result.${folder.status}`)}
                    {(folder.code || folder.reason) && <span className="text-muted-foreground"> ({wording(folder.code, folder.reason)})</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
