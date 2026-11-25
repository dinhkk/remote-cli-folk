import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePlugins, PluginIcon } from '@/modules/plugins';
import { cn } from '@/shared/utils';
import {
  BASE_TABS,
  BROWSER_TAB,
  TASKS_TAB,
  type TabDefinition,
  type WorkspaceTabsProps,
} from '@/modules/project-workspace/workspaceTabsTypes';

/**
 * Mobile-friendly dropdown menu for switching workspace views (Chat, Shell, Files, Git, etc.).
 * Placed on the right side of WorkspaceHeader on mobile screens to save vertical real estate.
 */
export default function WorkspaceTabsDropdown({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const builtInTabs = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: TabDefinition[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}`,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const allTabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];
  const activeTabDef = allTabs.find((tab) => tab.id === activeTab) || BASE_TABS[0];

  const handleSelectTab = useCallback(
    (tabId: TabDefinition['id']) => {
      setActiveTab(tabId);
      setIsOpen(false);
      triggerRef.current?.focus();
    },
    [setActiveTab],
  );

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const activeLabel =
    activeTabDef.kind === 'builtin' ? t(activeTabDef.labelKey) : activeTabDef.label;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-label={t('tabs.switchTab', { defaultValue: 'Switch view: {{tab}}', tab: activeLabel })}
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
          isOpen
            ? 'border-primary/50 bg-accent text-foreground'
            : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-accent/80 hover:text-foreground',
        )}
      >
        <span className="flex items-center text-primary">
          {activeTabDef.kind === 'builtin' ? (
            <activeTabDef.icon className="h-4 w-4 shrink-0" strokeWidth={2.2} />
          ) : (
            <PluginIcon
              pluginName={activeTabDef.pluginName}
              iconFile={activeTabDef.iconFile}
              className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
            />
          )}
        </span>

        <span className="max-w-[70px] truncate font-medium text-foreground">{activeLabel}</span>

        <ChevronDown
          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-150', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
          className="animate-in fade-in-0 zoom-in-95 absolute right-0 top-full z-50 mt-1.5 min-w-48 origin-top-right rounded-xl border border-border/80 bg-background/95 p-1.5 shadow-xl backdrop-blur-md duration-100"
        >
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('tabs.views', { defaultValue: 'Workspace views' })}
          </div>
          <div className="my-1 h-px bg-border/60" />

          <div className="flex flex-col gap-0.5">
            {allTabs.map((tab) => {
              const isActive = tab.id === activeTab;
              const label = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

              return (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  aria-checked={isActive}
                  onClick={() => handleSelectTab(tab.id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors text-left outline-none focus-visible:bg-accent',
                    isActive
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'text-foreground hover:bg-accent/80',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {tab.kind === 'builtin' ? (
                      <tab.icon
                        className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')}
                        strokeWidth={isActive ? 2.2 : 1.8}
                      />
                    ) : (
                      <PluginIcon
                        pluginName={tab.pluginName}
                        iconFile={tab.iconFile}
                        className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                      />
                    )}
                    <span className="truncate">{label}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
