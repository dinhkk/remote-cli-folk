import { useTranslation } from 'react-i18next';

/**
 * A Controller's device name with the "Unverified" label the Host owner must
 * always see next to it: the Controller picks the name itself, so it proves
 * nothing about who is connecting. Rendered as plain text, never as markup.
 * Used by HostControllersPanel and PairHostDialog.
 */
export function UnverifiedDeviceName({ name }: { name: string }) {
  const { t } = useTranslation('remote');

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="truncate font-medium text-foreground">{name}</span>
      <span
        title={t('device.unverifiedHint')}
        className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
      >
        {t('device.unverified')}
      </span>
    </span>
  );
}
