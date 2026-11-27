import { Wand2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentEntryRow } from '@/modules/agent-profiles/agents/AgentEntryRow';
import { GenerateAgentsForm } from '@/modules/agent-profiles/agents/GenerateAgentsForm';
import { GLOBAL_TARGET_ID, resolveGenerateTarget } from '@/modules/agent-profiles/agents/generate-target';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { api, ApiRequestError, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { AgentProfileTemplate, ClaudeAgentEntry, GenerateTargetProject } from '@/shared/types';

const NO_NAMES: string[] = [];

type AgentsTabProps = {
  /** The sidebar projects the agent files can be generated for. */
  projects: GenerateTargetProject[];
  /** The chosen target: {@link GLOBAL_TARGET_ID} or a project id. Owned by the panel, which loads the list for it. */
  targetId: string;
  onTargetChange: (targetId: string) => void;
  templates: AgentProfileTemplate[];
  entries: ClaudeAgentEntry[];
  status: 'loading' | 'ready' | 'error';
  loadError: unknown;
  /** Whether the built-in list came from the Claude CLI or is a static fallback. */
  builtinSource: 'sdk' | 'fallback' | null;
  /** Edits the stored hide list (receives it raw, returns the new one) and saves it; rejects on a stale revision. */
  onChangeHidden: (mutate: (names: string[]) => string[]) => Promise<void>;
  /** The names allowed to use the `profiles` tools as stored; with `onChangeManagers`, file agent rows get a "Profile manager" switch. */
  managerNames?: string[];
  /** Edits the stored manager list (receives it raw, returns the new one) and saves it; rejects on a stale revision. */
  onChangeManagers?: (mutate: (names: string[]) => string[]) => Promise<void>;
  /** Reads the agent list again (after Generate, or when a hide change was refused as stale). */
  onReload: () => void;
};

/**
 * The Agents tab: the agent files of the chosen target grouped by source (built into Claude Code, personal
 * `~/.claude/agents`, the project's `.claude/agents`), each marked generated (with its template) or handmade and with a
 * hide/show switch and, for file agents, a "Profile manager" switch, plus hide-all/show-all and a hidden-only filter. The target is a sidebar project or the global scope;
 * "Generate agents" opens the Generate form for it. Hiding applies to new sessions of every project.
 * Rendered by the agent-profiles panel.
 */
export function AgentsTab({ projects, targetId, onTargetChange, templates, entries, status, loadError, builtinSource, onChangeHidden, managerNames = NO_NAMES, onChangeManagers, onReload }: AgentsTabProps) {
  const { t } = useTranslation('agentProfiles');
  const { error, busy, run } = useProfileAction();
  // Show only the hidden agents.
  const [hiddenOnly, setHiddenOnly] = useState(false);
  // Whether the Generate form is open above the list.
  const [generating, setGenerating] = useState(false);

  const { project, target } = resolveGenerateTarget(projects, targetId);

  const readable = entries.filter((entry) => !entry.error);
  const visibleCount = readable.filter((entry) => !entry.hidden).length;
  const shown = entries.filter((entry) => !hiddenOnly || entry.hidden);
  const hiddenNames = [...new Set(readable.filter((entry) => entry.hidden).map((entry) => entry.name))];
  // Every name the listing shows; hide-all/show-all touch these and leave other stored names alone.
  const listedNames = [...new Set(entries.map((entry) => entry.name))];

  const hide = async (name: string, visible: boolean) => {
    // Only this one name is added or removed; names the listing does not show stay on the stored list.
    await run(() => onChangeHidden((stored) => (visible ? stored.filter((entry) => entry !== name) : [...new Set([...stored, name])])));
  };
  const setManager = (name: string, allowed: boolean) => {
    if (!onChangeManagers) return;
    void run(async () => {
      try {
        await onChangeManagers((stored) => (allowed ? [...new Set([...stored, name])] : stored.filter((entry) => entry !== name)));
      } catch (failure) {
        // A stale revision means the settings moved elsewhere: show what the server holds now (the notice stays up).
        if (failure instanceof ApiRequestError && failure.code === 'PROFILE_STALE') onReload();
        throw failure;
      }
    });
  };
  // Only a generated file agent can be deleted; the server re-checks the marker and refuses anything else.
  const removeGenerated = async (entry: ClaudeAgentEntry) => {
    if (!entry.generatedFrom || entry.source === 'builtin') return;
    if (!window.confirm(t('agents.deleteConfirm', { name: entry.name }))) return;
    const scope = entry.source === 'project' ? 'project' : 'user';
    const done = await run(async () => readApiJson(await api.agentProfiles.deleteGeneratedClaudeAgent(scope, entry.generatedFrom as string, scope === 'project' ? target.directory : null)));
    if (done !== undefined) onReload();
  };
  const hideAll = () => void run(() => onChangeHidden((stored) => [...new Set([...stored, ...readable.map((entry) => entry.name)])]));
  const showAll = () => void run(() => onChangeHidden((stored) => stored.filter((name) => !listedNames.includes(name))));

  const groups: Array<{ key: string; title: string; rows: ClaudeAgentEntry[] }> = [
    { key: 'builtin', title: t('agents.groupBuiltin'), rows: shown.filter((entry) => entry.source === 'builtin') },
    { key: 'user', title: t('agents.groupUser'), rows: shown.filter((entry) => entry.source === 'user') },
    { key: 'project', title: t('agents.groupProject', { name: project?.name ?? '' }), rows: shown.filter((entry) => entry.source === 'project') },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('agents.intro')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          {t('agents.target')}
          <select
            aria-label={t('agents.target')}
            value={targetId}
            onChange={(event) => { setGenerating(false); onTargetChange(event.target.value); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {projects.map((candidate) => <option key={candidate.projectId} value={candidate.projectId}>{candidate.name}</option>)}
            <option value={GLOBAL_TARGET_ID}>{t('agents.targetGlobal')}</option>
          </select>
        </label>
        <span className="flex-1" />
        <Button size="sm" disabled={templates.length === 0 || generating} onClick={() => setGenerating(true)}><Wand2 /> {t('generate.open')}</Button>
      </div>
      {projects.length === 0 && <p className="text-xs text-muted-foreground">{t('agents.noProjects')}</p>}

      {generating && (
        <GenerateAgentsForm
          key={targetId}
          templates={templates}
          target={target}
          onApplied={onReload}
          onClose={() => setGenerating(false)}
        />
      )}

      {builtinSource === 'fallback' && <p role="status" className="text-xs text-amber-600">{t('agents.fallbackNote')}</p>}

      {status === 'loading' && <p className="text-sm text-muted-foreground">{t('state.loading')}</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ProfileErrorNotice error={loadError} />
          <Button size="sm" variant="outline" onClick={onReload}>{t('state.retry')}</Button>
        </div>
      )}

      {status === 'ready' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="text-sm font-medium">{t('agents.summary', { visible: visibleCount, total: readable.length })}</p>
            <span className="flex-1" />
            <Button size="sm" variant="outline" disabled={busy || readable.length === 0} onClick={hideAll}>{t('agents.hideAll')}</Button>
            <Button size="sm" variant="outline" disabled={busy || hiddenNames.length === 0} onClick={showAll}>{t('agents.showAll')}</Button>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={hiddenOnly} onChange={(event) => setHiddenOnly(event.target.checked)} />
              {t('agents.hiddenOnly')}
            </label>
          </div>

          <ProfileErrorNotice error={error} onReload={onReload} />
          {groups.length === 0 && <p className="text-sm text-muted-foreground">{hiddenOnly ? t('agents.noneHidden') : t('agents.empty')}</p>}
          {groups.map((group) => (
            <section key={group.key} className="space-y-2">
              <h5 className="text-sm font-semibold">{group.title}</h5>
              <ul className="space-y-2">
                {group.rows.map((entry) => (
                  <AgentEntryRow
                    key={entry.path ?? `${entry.source}:${entry.name}`}
                    entry={entry}
                    busy={busy}
                    onSetVisible={(visible) => void hide(entry.name, visible)}
                    onDelete={entry.generatedFrom && entry.source !== 'builtin' ? () => void removeGenerated(entry) : undefined}
                    manager={onChangeManagers && entry.source !== 'builtin'
                      ? { checked: managerNames.includes(entry.name), onChange: (allowed) => setManager(entry.name, allowed) }
                      : undefined}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
