import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { useMemoryBlocks } from '@/modules/agent-profiles/hooks/useMemoryBlocks';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { MemoryBlockForm } from '@/modules/agent-profiles/memory/MemoryBlockForm';
import { MemoryBlockRow } from '@/modules/agent-profiles/memory/MemoryBlockRow';
import { agentsThatCanBypassLock } from '@/modules/agent-profiles/memory/memory-block-helpers';
import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { ClaudeAgentEntry, GenerateTargetProject, MemoryBlock } from '@/shared/types';

type MemoryTabProps = {
  /** The sidebar projects a folder can be added from to a project block. */
  projects: GenerateTargetProject[];
  /** The agent list the Agents tab loaded (for its current target); the source of the "read-only is not a hard lock" notice. */
  agents: ClaudeAgentEntry[];
  /** Whether that list is loaded: while it is not, no lock notice is shown (nothing is known yet). */
  agentsReady: boolean;
  /** Name of the target that list belongs to, named in the notice. */
  agentsTarget: string;
};

/**
 * The Memory tab of Settings → Agent Profiles: the app-owned memory blocks (name, mode, scope, size, last writer, update
 * time) with create / edit / delete (with confirmation) and the form; a project block expands to its folders. Says in plain
 * words what a block is: global or project scope only, never per agent, and only inside this app's chats. Blocks load when
 * the tab opens.
 * Rendered by the agent-profiles panel (Host only, like Templates: the server denies the routes to Remote).
 */
export function MemoryTab({ projects, agents, agentsReady, agentsTarget }: MemoryTabProps) {
  const { t } = useTranslation('agentProfiles');
  const { blocks, status, error: loadError, reload } = useMemoryBlocks();
  const { error, busy, run, clearError } = useProfileAction();
  // The block the form is on (null = a new one); undefined when the list shows. Switches between list and form.
  const [editing, setEditing] = useState<{ block: MemoryBlock | null } | undefined>(undefined);

  const risky = useMemo(() => (agentsReady ? agentsThatCanBypassLock(agents) : []), [agents, agentsReady]);

  const close = () => setEditing(undefined);
  const finish = () => {
    close();
    void reload();
  };
  // Opens the editor on the block as the server has it NOW, not as it was when the tab loaded: an agent may have written to
  // it since, and a form built on the old copy would be stale on its first save. A failed or superseded load opens nothing
  // (the list shows the failure with its retry); a block deleted meanwhile is simply gone from the refreshed list.
  const openEditor = async (block: MemoryBlock) => {
    clearError();
    const loaded = await run(() => reload());
    const current = loaded?.find((candidate) => candidate.id === block.id);
    if (current) setEditing({ block: current });
  };
  const remove = async (block: MemoryBlock) => {
    if (!window.confirm(t('memory.deleteConfirm', { name: block.name }))) return;
    if ((await run(async () => readApiJson(await api.agentProfiles.deleteMemoryBlock(block.id)))) !== undefined) void reload();
  };

  if (editing) {
    return (
      <MemoryBlockForm
        key={editing.block?.id ?? 'new'}
        block={editing.block}
        onSaved={finish}
        onCancel={close}
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('memory.intro')}</p>
      <p role="note" className="rounded-md border border-border bg-muted/40 p-2 text-xs">{t('memory.limits')}</p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => { clearError(); setEditing({ block: null }); }}><Plus /> {t('memory.new')}</Button>
      </div>
      <ProfileErrorNotice error={error} />

      {status === 'loading' && <p className="text-sm text-muted-foreground">{t('state.loading')}</p>}
      {/* A failed load shows only the error with its retry: the list would otherwise claim "nothing here yet". */}
      {status === 'error' && (
        <div className="space-y-2">
          <ProfileErrorNotice error={loadError} />
          <Button size="sm" variant="outline" onClick={() => void reload()}>{t('state.retry')}</Button>
        </div>
      )}
      {status === 'ready' && blocks.length === 0 && <p className="text-sm text-muted-foreground">{t('memory.empty')}</p>}
      {status !== 'error' && (
        <ul className="space-y-2">
          {blocks.map((block) => (
            <MemoryBlockRow
              key={block.id}
              block={block}
              projects={projects}
              risky={risky}
              agentsTarget={agentsTarget}
              busy={busy}
              onEdit={() => void openEditor(block)}
              onDelete={() => void remove(block)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
