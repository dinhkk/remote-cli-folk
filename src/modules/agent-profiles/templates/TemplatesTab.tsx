import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { TemplateEditor } from '@/modules/agent-profiles/templates/TemplateEditor';
import { api, readApiJson } from '@/shared/api';
import { Badge, Button } from '@/shared/ui';
import type { AgentProfileTemplate, ProfileCatalogs } from '@/shared/types';

type TemplatesTabProps = {
  templates: AgentProfileTemplate[];
  catalogs: ProfileCatalogs;
  loading: boolean;
  onReload: () => void;
};

/**
 * The Templates tab of Settings → Agent Profiles: the list (name, family, slug, agent memory scope) with create / edit /
 * delete, and the editor. Deleting a template never touches agent files already generated from it.
 * Rendered by the agent-profiles panel.
 */
export function TemplatesTab({ templates, catalogs, loading, onReload }: TemplatesTabProps) {
  const { t } = useTranslation('agentProfiles');
  const { error, busy, run, clearError } = useProfileAction();
  // Which template the editor is on (null = a new one); null when the list shows. Needed to switch between list and editor.
  const [editor, setEditor] = useState<{ template: AgentProfileTemplate | null } | null>(null);

  const close = () => setEditor(null);
  const finish = () => {
    close();
    onReload();
  };
  const remove = async (template: AgentProfileTemplate) => {
    if (!window.confirm(t('template.deleteConfirm', { name: template.name }))) return;
    if ((await run(async () => readApiJson(await api.agentProfiles.deleteTemplate(template.id)))) !== undefined) onReload();
  };

  if (editor) {
    return (
      <TemplateEditor
        key={editor.template?.id ?? 'new'}
        template={editor.template}
        templates={templates}
        catalogs={catalogs}
        onSaved={finish}
        onCancel={close}
        onReload={finish}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => { clearError(); setEditor({ template: null }); }}><Plus /> {t('template.new')}</Button>
      </div>
      <ProfileErrorNotice error={error} />
      {loading && <p className="text-sm text-muted-foreground">{t('state.loading')}</p>}
      {!loading && templates.length === 0 && <p className="text-sm text-muted-foreground">{t('template.empty')}</p>}
      <ul className="space-y-2">
        {templates.map((template) => (
          <li key={template.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{template.name}</span>
                <Badge variant="secondary">{t(`family.${template.family}`)}</Badge>
                {template.memory && <Badge variant="outline">{t('template.memoryBadge', { scope: t(`template.memoryScope.${template.memory}`) })}</Badge>}
                {template.usesBlocks && <Badge variant="outline">{t('template.blocksBadge')}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{template.slug}</p>
            </div>
            <Button size="sm" variant="ghost" aria-label={t('actions.editName', { name: template.name })} onClick={() => { clearError(); setEditor({ template }); }}><Pencil /></Button>
            <Button size="sm" variant="ghost" aria-label={t('actions.deleteName', { name: template.name })} disabled={busy} onClick={() => void remove(template)}><Trash2 /></Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
