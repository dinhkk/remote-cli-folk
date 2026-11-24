import type { TFunction } from 'i18next';

import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { ConversationProviderFilter } from '@/modules/sidebar/utils/providerFilter';
import type { LLMProvider } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';

export function SidebarProviderFilter({ value, onChange, t }: {
  value: ConversationProviderFilter;
  onChange: (value: ConversationProviderFilter) => void;
  t: TFunction;
}) {
  const choices: ConversationProviderFilter[] = ['all', ...Object.keys(PROVIDER_LABELS) as LLMProvider[]];
  return <div role="group" aria-label={t('providerFilter.label')} className="flex min-w-0 shrink-0 flex-wrap gap-1 px-2 py-2">
    {choices.map(provider => <button key={provider} type="button" aria-label={provider === 'all' ? t('providerFilter.all') : t('providerFilter.provider', { provider: PROVIDER_LABELS[provider] })} aria-pressed={value === provider}
      onClick={() => onChange(provider)}
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 ${value === provider ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}>
      {provider !== 'all' && <LLMProviderLogo provider={provider} className="h-3.5 w-3.5 shrink-0" />}
      {provider === 'all' ? t('providerFilter.all') : t('providerFilter.provider', { provider: PROVIDER_LABELS[provider] })}
    </button>)}
  </div>;
}
