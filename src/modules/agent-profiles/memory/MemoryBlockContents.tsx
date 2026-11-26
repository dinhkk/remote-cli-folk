import { Eraser, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { useMemoryBlockContents } from '@/modules/agent-profiles/hooks/useMemoryBlockContents';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { projectOfDirectory, writerWords } from '@/modules/agent-profiles/memory/memory-block-helpers';
import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { GenerateTargetProject, MemoryBlock, MemoryBlockProjectContent } from '@/shared/types';

type MemoryBlockContentsProps = {
  /** The project block whose folders are listed. */
  block: MemoryBlock;
  /** The sidebar projects a folder can be added from. */
  projects: GenerateTargetProject[];
};

/** The folder being edited, with the text in the editor and the content `rev` it was loaded with. */
type Draft = { directory: string; text: string; rev: number };

/**
 * The folder list of a project block: every folder that has a content file (size against the limit, last writer, update
 * time) with edit, empty (the file stays, so agents there keep the block) and "Remove folder" (the file goes, so the block
 * disappears for agents in that folder). "Add folder" picks a sidebar project and gives its folder an empty content file; the
 * block is visible to an agent only in folders listed here. Folders of deleted projects stay listed until removed here.
 * Used by the Memory block row of a project block.
 */
export function MemoryBlockContents({ block, projects }: MemoryBlockContentsProps) {
  const { t } = useTranslation('agentProfiles');
  const { error, busy, run, clearError } = useProfileAction();
  const { contents, corrupt, status, error: loadError, reload } = useMemoryBlockContents(block.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The sidebar project picked in "Add folder" (project id), or '' for none.
  const [pick, setPick] = useState('');

  // Runs a change, then reads the list again so the screen shows what the server holds.
  const change = async (action: () => Promise<Response>): Promise<boolean> => {
    const done = await run(async () => readApiJson(await action()));
    await reload();
    return done !== undefined;
  };

  const unusedProjects = projects.filter((project) => !contents.some((file) => projectOfDirectory([project], file.directory)));
  const picked = unusedProjects.find((project) => project.projectId === pick);

  const add = async () => {
    if (!picked) return;
    if (await change(() => api.agentProfiles.addMemoryBlockContent(block.id, picked.directory))) setPick('');
  };
  const save = async () => {
    if (!draft) return;
    if (await change(() => api.agentProfiles.updateMemoryBlockContent(block.id, { directory: draft.directory, content: draft.text, expectedRev: draft.rev }))) setDraft(null);
  };
  const empty = async (file: MemoryBlockProjectContent) => {
    if (!window.confirm(t('memory.folders.emptyConfirm', { directory: file.directory }))) return;
    await change(() => api.agentProfiles.emptyMemoryBlockContent(block.id, file.directory, file.rev));
  };
  const removeFolder = async (file: MemoryBlockProjectContent) => {
    if (!window.confirm(t('memory.folders.removeConfirm', { directory: file.directory, name: block.name }))) return;
    await change(() => api.agentProfiles.removeMemoryBlockFolder(block.id, file.directory, file.rev));
  };

  const overLimit = draft !== null && draft.text.length > block.maxChars;

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
      <p className="text-xs text-muted-foreground">{t('memory.folders.visibility')}</p>

      {status === 'loading' && <p className="text-sm text-muted-foreground">{t('state.loading')}</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ProfileErrorNotice error={loadError} />
          <Button size="sm" variant="outline" onClick={() => void reload()}>{t('state.retry')}</Button>
        </div>
      )}
      {corrupt.length > 0 && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {t('memory.folders.corrupt', { count: corrupt.length })}
        </p>
      )}
      {status === 'ready' && contents.length === 0 && <p className="text-sm text-muted-foreground">{t('memory.folders.empty')}</p>}

      <ul className="space-y-2">
        {contents.map((file) => {
          const project = projectOfDirectory(projects, file.directory);
          const words = writerWords(file.lastWriter);
          const updated = new Date(file.updatedAt);
          const editing = draft?.directory === file.directory;
          return (
            <li key={file.directory} className="space-y-1 rounded-md border border-border bg-background p-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 text-sm">
                  {project && <span className="font-medium">{project.name} </span>}
                  <span className="break-all text-xs text-muted-foreground">{file.directory}</span>
                </div>
                <Button size="sm" variant="ghost" aria-label={t('memory.folders.edit', { directory: file.directory })} disabled={busy} onClick={() => { clearError(); setDraft({ directory: file.directory, text: file.content, rev: file.rev }); }}><Pencil /></Button>
                <Button size="sm" variant="ghost" aria-label={t('memory.folders.emptyAction', { directory: file.directory })} disabled={busy} onClick={() => void empty(file)}><Eraser /></Button>
                <Button size="sm" variant="ghost" aria-label={t('memory.folders.remove', { directory: file.directory })} disabled={busy} onClick={() => void removeFolder(file)}><Trash2 /></Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('memory.size', { used: file.content.length, max: block.maxChars })}
                {' · '}{t(words.key, { name: words.name })}
                {' · '}{Number.isNaN(updated.getTime()) ? file.updatedAt : updated.toLocaleString()}
              </p>
              {editing && draft && (
                <div className="space-y-2">
                  <textarea
                    aria-label={t('memory.folders.contentOf', { directory: file.directory })}
                    rows={6}
                    value={draft.text}
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
                  />
                  <p className={overLimit ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                    {overLimit ? t('memory.form.contentTooLong', { max: block.maxChars }) : t('memory.form.contentCount', { used: draft.text.length, max: block.maxChars })}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy || overLimit} onClick={() => void save()}>{t('actions.save')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => { clearError(); setDraft(null); }}>{t('actions.cancel')}</Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('memory.folders.pickProject')}
          value={picked ? pick : ''}
          onChange={(event) => setPick(event.target.value)}
          className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">{t('memory.folders.pickPlaceholder')}</option>
          {unusedProjects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={!picked || busy} onClick={() => void add()}>{t('memory.folders.add')}</Button>
      </div>
      {projects.length === 0 && <p className="text-xs text-muted-foreground">{t('memory.folders.noProjects')}</p>}
      <ProfileErrorNotice error={error} onReload={() => { clearError(); setDraft(null); void reload(); }} />
    </div>
  );
}
