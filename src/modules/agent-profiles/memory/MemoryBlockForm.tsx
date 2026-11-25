import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GLOBAL_TARGET_ID } from '@/modules/agent-profiles/agents/generate-target';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { ProfileField } from '@/modules/agent-profiles/common/ProfileField';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { projectOfScope, writerWords } from '@/modules/agent-profiles/memory/memory-block-helpers';
import { ApiRequestError, api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { isValidProfileSlug } from '@/shared/utils';
import type { GenerateTargetProject, MemoryBlock, MemoryBlockInput, MemoryBlockMode, MemoryBlockScope } from '@/shared/types';

/** `maxChars` of a new block, and the most the server accepts. */
const DEFAULT_MAX_CHARS = 2000;
const HARD_MAX_CHARS = 20000;

/** Scope choice of a block whose folder is not a sidebar project (any more): kept as it is so editing never moves the block. */
const KEPT_FOLDER_ID = '@kept-folder';

type MemoryBlockFormProps = {
  /** The block being edited, or null to create a new one. */
  block: MemoryBlock | null;
  /** The sidebar projects a block can be scoped to (picked like Generate picks its target; no free-text path). */
  projects: GenerateTargetProject[];
  /** Called after a successful save so the tab can reload and close the form. */
  onSaved: () => void;
  onCancel: () => void;
};

/** Who changed a block behind the editor's back, as far as the server told us (`lastWriter` is null when nobody has written yet). */
type ChangedBehind = { lastWriter: string | null } | 'unknown';

/** The scope select value of a stored scope: global, the matching sidebar project, or the kept folder. */
function scopeChoiceOf(block: MemoryBlock | null, projects: GenerateTargetProject[]): string {
  if (!block || block.scope.kind === 'global') return GLOBAL_TARGET_ID;
  return projectOfScope(projects, block.scope)?.projectId ?? KEPT_FOLDER_ID;
}

/**
 * The create/edit form of a memory block: name (slug), description, mode, scope (global or a sidebar project), content and
 * the size limit. Saving is blocked on an invalid name or limit and on content longer than the limit; the server has the
 * last word (name taken in any scope, block limit, stale `rev`) and its answer shows in place. The user may edit read-only
 * blocks. A stale save (an agent or another window changed the block meanwhile) never closes the form or drops the draft:
 * only the revision the next save is based on is refreshed, and the notice says who changed the block, so the user can save
 * again over that change or cancel. Used by the Memory tab.
 */
export function MemoryBlockForm({ block, projects, onSaved, onCancel }: MemoryBlockFormProps) {
  const { t } = useTranslation('agentProfiles');
  const { error, busy, run } = useProfileAction();
  // The revision the next save is based on (the one the editor loaded; refreshed after a stale refusal, the draft untouched).
  const [baseRev, setBaseRev] = useState(block?.rev ?? 0);
  // Set when the last save was refused as stale: who wrote the block in the meantime.
  const [changedBehind, setChangedBehind] = useState<ChangedBehind | null>(null);
  // The fields below start from the block and are edited locally until Save.
  const [name, setName] = useState(block?.name ?? '');
  const [description, setDescription] = useState(block?.description ?? '');
  const [mode, setMode] = useState<MemoryBlockMode>(block?.mode ?? 'writable');
  // Global (empty), a sidebar project id, or the kept folder of a block whose project left the sidebar.
  const [scopeChoice, setScopeChoice] = useState(scopeChoiceOf(block, projects));
  const [content, setContent] = useState(block?.content ?? '');
  // Kept as text so a half-typed number does not jump around; parsed on save.
  const [maxCharsText, setMaxCharsText] = useState(String(block?.maxChars ?? DEFAULT_MAX_CHARS));

  const maxChars = /^\d+$/.test(maxCharsText.trim()) ? Number(maxCharsText.trim()) : NaN;
  const maxCharsProblem = Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= HARD_MAX_CHARS ? null : t('memory.form.maxCharsInvalid', { max: HARD_MAX_CHARS });
  const nameProblem = name === '' || isValidProfileSlug(name) ? null : t('memory.form.nameInvalid');
  const contentProblem = !maxCharsProblem && content.length > maxChars ? t('memory.form.contentTooLong', { max: maxChars }) : null;
  const blocked = !name || Boolean(nameProblem) || Boolean(maxCharsProblem) || Boolean(contentProblem);

  const keptFolder = block?.scope.kind === 'project' && scopeChoiceOf(block, projects) === KEPT_FOLDER_ID ? block.scope.directory : null;

  const scopeOf = (): MemoryBlockScope => {
    if (scopeChoice === KEPT_FOLDER_ID && keptFolder) return { kind: 'project', directory: keptFolder };
    const project = projects.find((candidate) => candidate.projectId === scopeChoice);
    return project ? { kind: 'project', directory: project.directory } : { kind: 'global' };
  };

  /** Reads the block's current revision and writer after a stale refusal; the form fields are not touched. */
  const refreshBaseline = async (id: string, failure: ApiRequestError) => {
    const currentRev = (failure.details as { currentRev?: unknown } | undefined)?.currentRev;
    if (typeof currentRev === 'number') setBaseRev(currentRev);
    try {
      const { blocks } = await readApiJson<{ blocks: MemoryBlock[] }>(await api.agentProfiles.listMemoryBlocks());
      const current = blocks.find((candidate) => candidate.id === id);
      if (current) {
        setBaseRev(current.rev);
        setChangedBehind({ lastWriter: current.lastWriter });
        return;
      }
    } catch {
      // The list could not be read: the notice then says the block changed without naming who.
    }
    setChangedBehind('unknown');
  };

  const save = async () => {
    const input: MemoryBlockInput = { name, description: description.trim(), mode, scope: scopeOf(), content, maxChars };
    setChangedBehind(null);
    const saved = await run(async () => {
      try {
        return await readApiJson(await (block
          ? api.agentProfiles.updateMemoryBlock(block.id, { ...input, expectedRev: baseRev })
          : api.agentProfiles.createMemoryBlock(input)));
      } catch (failure) {
        if (block && failure instanceof ApiRequestError && failure.code === 'PROFILE_STALE') await refreshBaseline(block.id, failure);
        throw failure;
      }
    });
    if (saved !== undefined) onSaved();
  };

  const isStale = Boolean(block) && error instanceof ApiRequestError && error.code === 'PROFILE_STALE';
  const changedBy = changedBehind !== null && changedBehind !== 'unknown' ? writerWords(changedBehind.lastWriter) : null;

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h4 className="text-base font-semibold">{block ? t('memory.form.editTitle', { name: block.name }) : t('memory.form.newTitle')}</h4>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProfileField label={t('memory.form.name')} htmlFor="memory-name" error={nameProblem} hint={t('memory.form.nameHint')}>
          <Input id="memory-name" value={name} onChange={(event) => setName(event.target.value)} />
        </ProfileField>
        <ProfileField label={t('memory.form.mode')} htmlFor="memory-mode" hint={t(`memory.form.modeHint.${mode}`)}>
          <select
            id="memory-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as MemoryBlockMode)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="writable">{t('memory.mode.writable')}</option>
            <option value="read-only">{t('memory.mode.read-only')}</option>
          </select>
        </ProfileField>
      </div>

      <ProfileField label={t('memory.form.description')} htmlFor="memory-description" hint={t('memory.form.descriptionHint')}>
        <Input id="memory-description" value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
      </ProfileField>

      <ProfileField label={t('memory.form.scope')} htmlFor="memory-scope" hint={t('memory.form.scopeHint')}>
        <select
          id="memory-scope"
          value={scopeChoice}
          onChange={(event) => setScopeChoice(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value={GLOBAL_TARGET_ID}>{t('memory.scopeGlobal')}</option>
          {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
          {keptFolder && <option value={KEPT_FOLDER_ID}>{t('memory.form.keptFolder', { directory: keptFolder })}</option>}
        </select>
      </ProfileField>
      {projects.length === 0 && <p className="text-xs text-muted-foreground">{t('memory.form.noProjects')}</p>}

      <ProfileField label={t('memory.form.content')} htmlFor="memory-content" error={contentProblem} hint={t('memory.form.contentCount', { used: content.length, max: Number.isNaN(maxChars) ? DEFAULT_MAX_CHARS : maxChars })}>
        <textarea id="memory-content" rows={8} value={content} onChange={(event) => setContent(event.target.value)} className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs" />
      </ProfileField>

      <ProfileField label={t('memory.form.maxChars')} htmlFor="memory-max-chars" error={maxCharsProblem} hint={t('memory.form.maxCharsHint', { max: HARD_MAX_CHARS })}>
        <Input id="memory-max-chars" inputMode="numeric" value={maxCharsText} onChange={(event) => setMaxCharsText(event.target.value)} />
      </ProfileField>

      {isStale ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {changedBy
            ? t('memory.form.stale', { writer: t(changedBy.key, { name: changedBy.name }) })
            : t('memory.form.staleUnknownWriter')}
        </p>
      ) : <ProfileErrorNotice error={error} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={blocked || busy}>{t('actions.save')}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button>
      </div>
    </form>
  );
}
