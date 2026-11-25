import { Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { showsLockWarning, writerWords } from '@/modules/agent-profiles/memory/memory-block-helpers';
import { Badge, Button } from '@/shared/ui';
import type { ClaudeAgentEntry, MemoryBlock } from '@/shared/types';

type MemoryBlockRowProps = {
  block: MemoryBlock;
  /** Agents of the loaded list that have Bash or no tool limit (see `agentsThatCanBypassLock`). */
  risky: ClaudeAgentEntry[];
  /** Name of the target the loaded agent list belongs to, named in the lock notice. */
  agentsTarget: string;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * One block of the Memory list: name, mode badge, scope (global or the project folder), size against its limit, last
 * writer and update time, with edit and delete. A read-only block also shows the "not a hard lock" notice while some
 * listed agent has Bash or no tool limit. Used by the Memory tab.
 */
export function MemoryBlockRow({ block, risky, agentsTarget, busy, onEdit, onDelete }: MemoryBlockRowProps) {
  const { t } = useTranslation('agentProfiles');
  const updated = new Date(block.updatedAt);
  // Who wrote the content last, in words: nobody yet, the user, or an agent by name.
  const words = writerWords(block.lastWriter);
  const writer = t(words.key, { name: words.name });

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{block.name}</span>
            <Badge variant={block.mode === 'writable' ? 'secondary' : 'outline'}>{t(`memory.mode.${block.mode}`)}</Badge>
          </div>
          {block.description && <p className="text-xs text-muted-foreground">{block.description}</p>}
        </div>
        <Button size="sm" variant="ghost" aria-label={t('actions.editName', { name: block.name })} onClick={onEdit}><Pencil /></Button>
        <Button size="sm" variant="ghost" aria-label={t('actions.deleteName', { name: block.name })} disabled={busy} onClick={onDelete}><Trash2 /></Button>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="flex gap-1">
          <dt>{t('memory.scopeLabel')}:</dt>
          <dd className="min-w-0 break-all text-foreground">
            {block.scope.kind === 'global' ? t('memory.scopeGlobal') : block.scope.directory}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('memory.sizeLabel')}:</dt>
          <dd className="text-foreground">{t('memory.size', { used: block.content.length, max: block.maxChars })}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('memory.writerLabel')}:</dt>
          <dd className="text-foreground">{writer}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('memory.updatedLabel')}:</dt>
          <dd className="text-foreground">{Number.isNaN(updated.getTime()) ? block.updatedAt : updated.toLocaleString()}</dd>
        </div>
      </dl>
      {showsLockWarning(block, risky) && (
        <p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          {t('memory.lockWarning', { count: risky.length, names: risky.map((agent) => agent.name).join(', '), target: agentsTarget })}
        </p>
      )}
    </li>
  );
}
