import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { ConversationProviderFilter } from '@/modules/sidebar/utils/providerFilter';
import type { LLMProvider } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';

/** How long the scrollbar stays visible after the last scroll event, so a swipe leaves it on screen briefly. */
const SCROLLBAR_VISIBLE_MS = 1000;

/** Used by SidebarContent to filter the conversation list by provider, in a row that scrolls sideways when it does not fit. */
export function SidebarProviderFilter({ value, onChange, t }: {
  value: ConversationProviderFilter;
  onChange: (value: ConversationProviderFilter) => void;
  t: TFunction;
}) {
  const choices: ConversationProviderFilter[] = ['all', ...Object.keys(PROVIDER_LABELS) as LLMProvider[]];
  const [isScrolling, setIsScrolling] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  // The CSS reveals the bar on hover; a swipe has no hover, so scrolling itself switches it on for a moment.
  const handleScroll = () => {
    setIsScrolling(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setIsScrolling(false), SCROLLBAR_VISIBLE_MS);
  };

  useEffect(() => () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
  }, []);

  return <div role="group" aria-label={t('providerFilter.label')} data-scrolling={isScrolling} onScroll={handleScroll} className="scrollbar-reveal flex min-w-0 shrink-0 transform-gpu gap-1 overflow-x-auto mx-3 py-2">
    {choices.map(provider => <button key={provider} type="button" aria-label={provider === 'all' ? t('providerFilter.all') : t('providerFilter.provider', { provider: PROVIDER_LABELS[provider] })} aria-pressed={value === provider}
      onClick={() => onChange(provider)}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 ${value === provider ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}>
      {provider !== 'all' && <LLMProviderLogo provider={provider} className="h-3.5 w-3.5 shrink-0" />}
      {provider === 'all' ? t('providerFilter.all') : t('providerFilter.provider', { provider: PROVIDER_LABELS[provider] })}
    </button>)}
  </div>;
}
