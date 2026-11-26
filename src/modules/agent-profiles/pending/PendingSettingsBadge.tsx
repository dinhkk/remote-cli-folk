import { useTranslation } from 'react-i18next';

import { usePendingCount } from '@/modules/agent-profiles/pending/usePendingCount';

/** Largest number shown as is; more reads "99+". */
const MAX_SHOWN = 99;

/**
 * A small number badge for the corner of the Settings button: how many proposals of manager agents wait for the user's
 * confirmation. Renders nothing at zero and in a Remote target (the count is Host only). Place it inside a `relative` button.
 * Used by the sidebar module on its Settings buttons.
 */
export function PendingSettingsBadge() {
  const { t } = useTranslation('agentProfiles');
  const count = usePendingCount();
  if (count <= 0) return null;
  return (
    <span
      data-pending-count
      title={t('pending.badgeTitle', { count })}
      className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
    >
      {count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
    </span>
  );
}
