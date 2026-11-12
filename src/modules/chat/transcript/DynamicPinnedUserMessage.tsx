import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, CircleDot, Loader2, Maximize2, Minimize2, Pin } from 'lucide-react';

import type { ChatMessage } from '@/shared/types';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { cn } from '@/shared/utils';

type DynamicPinnedUserMessageProps = {
  message: ChatMessage | null;
  isProcessing?: boolean;
  onJumpToMessage: (message: ChatMessage) => void;
  actions?: React.ReactNode;
  isMobile?: boolean;
};

export const DynamicPinnedUserMessage = memo(({
  message,
  isProcessing = false,
  onJumpToMessage,
  actions,
  isMobile: propIsMobile,
}: DynamicPinnedUserMessageProps) => {
  const { t } = useTranslation('chat');
  const device = useDeviceSettings({ trackPWA: false });
  const isMobile = propIsMobile ?? device.isMobile;

  const [isExpanded, setIsExpanded] = useState(false);
  const [isCircleCollapsed, setIsCircleCollapsed] = useState(false);

  if (!message || message.type !== 'user') {
    return null;
  }

  const content = (message.content || '').trim();
  if (!content) {
    return null;
  }

  // Mobile layout: translucent bubble card with option to collapse to circular bubble or expand full width
  if (isMobile) {
    if (isCircleCollapsed) {
      return (
        <div
          role="region"
          aria-label="Pinned user message"
          className="pointer-events-none sticky top-2 z-20 flex items-center justify-end gap-2 px-3"
        >
          {actions && <div className="pointer-events-auto">{actions}</div>}
          <button
            type="button"
            onClick={() => setIsCircleCollapsed(false)}
            className="pointer-events-auto relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-background/85 text-primary shadow-lg backdrop-blur-md transition-all duration-200 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 active:scale-95"
            title={t('pinned.openActivePrompt', 'Open active prompt')}
            aria-label={t('pinned.openActivePrompt', 'Open active prompt')}
          >
            <Pin className="h-4 w-4" />
            {isProcessing && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-purple-500" />
              </span>
            )}
          </button>
        </div>
      );
    }

    return (
      <div
        role="region"
        aria-label="Pinned user message"
        className={cn(
          'sticky top-2 z-20 transition-all duration-150',
          isExpanded ? 'mx-2 my-1' : 'mx-3 my-1',
        )}
      >
        <div
          className={cn(
            'flex flex-col border border-border/70 bg-background/80 shadow-lg backdrop-blur-md transition-all',
            isExpanded ? 'rounded-xl p-3' : 'rounded-2xl px-3 py-1.5',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onJumpToMessage(message)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onJumpToMessage(message);
                }
              }}
              className="group flex min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
              title={t('pinned.jumpToMessage', 'Jump to this message')}
            >
              <Pin className="h-3.5 w-3.5 shrink-0 text-primary/80 transition-transform group-hover:scale-110" />

              {isProcessing && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  {isExpanded && <span>{t('pinned.processing', 'Processing...')}</span>}
                </span>
              )}

              {!isExpanded && (
                <span className="min-w-0 flex-1 truncate font-serif text-xs text-foreground/90">
                  {content}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <button
                type="button"
                onClick={() => setIsExpanded((prev) => !prev)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                title={isExpanded ? t('pinned.collapse', 'Collapse') : t('pinned.expandFullWidth', 'Full width')}
                aria-label={isExpanded ? t('pinned.collapse', 'Collapse') : t('pinned.expandFullWidth', 'Full width')}
              >
                {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setIsCircleCollapsed(true)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                title={t('pinned.collapseToCircle', 'Collapse to bubble')}
                aria-label={t('pinned.collapseToCircle', 'Collapse to bubble')}
              >
                <CircleDot className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {isExpanded && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                const selection = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
                if (selection && selection.length > 0) return;
                onJumpToMessage(message);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onJumpToMessage(message);
                }
              }}
              className="mt-1.5 cursor-pointer font-serif text-xs leading-relaxed text-foreground/90 max-h-60 overflow-y-auto whitespace-pre-wrap"
              title={t('pinned.clickToJump', 'Click to scroll to message')}
            >
              {content}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Desktop layout: standard sticky bar
  return (
    <div
      role="region"
      aria-label="Pinned user message"
      className="shadow-xs sticky top-0 z-20 w-full border-b border-border/60 bg-background/95 backdrop-blur-md transition-all"
    >
      <div className="mx-auto flex max-w-[54.25rem] flex-col px-4 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <div
            role="button"
            tabIndex={0}
            onClick={() => onJumpToMessage(message)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onJumpToMessage(message);
              }
            }}
            className="group flex min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
            title={t('pinned.jumpToMessage', 'Jump to this message')}
          >
            <Pin className="h-3.5 w-3.5 shrink-0 text-primary/80 transition-transform group-hover:scale-110" />

            {isProcessing && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                <span>{t('pinned.processing', 'Processing...')}</span>
              </span>
            )}

            {!isExpanded && (
              <span className="min-w-0 flex-1 truncate font-serif text-xs text-foreground/90">
                {content}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <button
              type="button"
              onClick={() => setIsExpanded((prev) => !prev)}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={isExpanded ? t('pinned.collapse', 'Collapse') : t('pinned.expand', 'Expand')}
              aria-label={isExpanded ? t('pinned.collapse', 'Collapse') : t('pinned.expand', 'Expand')}
            >
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {isExpanded && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              const selection = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
              if (selection && selection.length > 0) return;
              onJumpToMessage(message);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onJumpToMessage(message);
              }
            }}
            className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap font-serif text-xs leading-relaxed text-foreground/90 transition-all"
            title={t('pinned.clickToJump', 'Click to scroll to message')}
          >
            {content}
          </div>
        )}
      </div>
    </div>
  );
});

DynamicPinnedUserMessage.displayName = 'DynamicPinnedUserMessage';
export default DynamicPinnedUserMessage;
