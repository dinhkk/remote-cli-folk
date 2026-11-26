import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProfileSwitch } from '@/modules/agent-profiles/common/ProfileSwitch';
import { Badge } from '@/shared/ui';
import type { ClaudeAgentEntry } from '@/shared/types';

type AgentEntryRowProps = {
  entry: ClaudeAgentEntry;
  busy: boolean;
  /** Shows or hides the agent for new sessions of every project. */
  onSetVisible: (visible: boolean) => void;
  /** The "Profile manager" switch of a file agent; absent = the row offers none. */
  manager?: { checked: boolean; onChange: (allowed: boolean) => void };
};

/**
 * One agent of the Agents list: name, model, whether its file was generated from a template or written by hand,
 * the visible/hidden switch, the optional "Profile manager" switch and a read-only details view (tools, file, prompt). An entry whose file could not be parsed
 * shows the file and the reason instead. Used by the Agents tab of the agent-profiles module.
 */
export function AgentEntryRow({ entry, busy, onSetVisible, manager }: AgentEntryRowProps) {
  const { t } = useTranslation('agentProfiles');
  // Whether the read-only details are open; local because only this row cares.
  const [open, setOpen] = useState(false);

  if (entry.error) {
    return (
      <li role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        {t('agents.fileError', { name: entry.name, error: entry.error })}
      </li>
    );
  }

  const isFile = entry.source !== 'builtin';
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-expanded={open} aria-label={t('agents.details', { name: entry.name })} onClick={() => setOpen((current) => !current)} className="text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="font-medium">{entry.name}</span>
        {entry.model && <Badge variant="outline">{entry.model}</Badge>}
        {isFile && (entry.generated
          ? <Badge variant="secondary">{entry.generatedFrom ? t('agents.generatedFrom', { template: entry.generatedFrom }) : t('agents.generated')}</Badge>
          : <Badge variant="outline">{t('agents.handmade')}</Badge>)}
        {entry.hidden && <Badge variant="secondary">{t('agents.hiddenBadge')}</Badge>}
        <span className="flex-1" />
        <ProfileSwitch checked={!entry.hidden} onChange={onSetVisible} disabled={busy} ariaLabel={t('agents.visibleFor', { name: entry.name })} />
      </div>
      <p className="text-xs text-muted-foreground">{entry.description}</p>
      {manager && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <ProfileSwitch checked={manager.checked} onChange={manager.onChange} disabled={busy} ariaLabel={t('agents.manager.switch', { name: entry.name })} />
          <span className="font-medium">{t('agents.manager.label')}</span>
          <span className="min-w-0 flex-1 text-muted-foreground">{t('agents.manager.hint')}</span>
        </div>
      )}
      {open && (
        <div className="space-y-1 rounded-md bg-muted/30 p-2 text-xs">
          {entry.path && <p className="break-all font-mono">{entry.path}</p>}
          {entry.tools && <p>{t('agents.tools', { tools: entry.tools.join(', ') })}</p>}
          {entry.source === 'builtin' ? (
            <p className="text-muted-foreground">{t('agents.noPrompt')}</p>
          ) : (
            <pre aria-label={t('agents.prompt', { name: entry.name })} className="max-h-64 overflow-auto whitespace-pre-wrap">{entry.prompt}</pre>
          )}
        </div>
      )}
    </li>
  );
}
