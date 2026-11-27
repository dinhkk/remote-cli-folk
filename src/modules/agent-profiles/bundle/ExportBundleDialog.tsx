import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BundleDialogFrame } from '@/modules/agent-profiles/bundle/BundleDialogFrame';
import { BundleErrorNotice } from '@/modules/agent-profiles/bundle/BundleErrorNotice';
import { downloadTextFile } from '@/modules/agent-profiles/bundle/bundle-helpers';
import { useBundleActions } from '@/modules/agent-profiles/bundle/useBundleActions';
import { useMemoryBlocks } from '@/modules/agent-profiles/hooks/useMemoryBlocks';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { Button } from '@/shared/ui';
import type { AgentProfileTemplate, ExportProblem } from '@/shared/types';

type ExportBundleDialogProps = {
  /** The templates the panel already loaded; every one is ticked at first. */
  templates: AgentProfileTemplate[];
  onClose: () => void;
};

/**
 * The Export dialog of the Agent Profiles panel: tick the templates and memory blocks to include, choose whether the text of
 * blocks (every folder of project blocks, with its folder path) travels (off by default) and the format (YAML by
 * default), then save the file the server builds under the name it returns. Warns that the file may hold private content.
 * Used by the agent-profiles panel (Host only).
 */
export function ExportBundleDialog({ templates, onClose }: ExportBundleDialogProps) {
  const { t } = useTranslation('agentProfiles');
  const actions = useBundleActions();
  const { blocks, status: blocksStatus, error: blocksError } = useMemoryBlocks();
  // Ids the user un-ticked: everything is included unless listed here, so a list that loads later is ticked too.
  const [leftOutTemplates, setLeftOutTemplates] = useState<ReadonlySet<string>>(new Set());
  const [leftOutBlocks, setLeftOutBlocks] = useState<ReadonlySet<string>>(new Set());
  const [includeBlockContent, setIncludeBlockContent] = useState(false);
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const [saved, setSaved] = useState<{ filename: string; problems: ExportProblem[] } | null>(null);

  const templateIds = templates.filter((template) => !leftOutTemplates.has(template.id)).map((template) => template.id);
  const blockIds = blocks.filter((block) => !leftOutBlocks.has(block.id)).map((block) => block.id);

  const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const run = async () => {
    setSaved(null);
    const answer = await actions.exportBundle({ templateIds, blockIds, includeBlockContent, format });
    if (!answer) return;
    downloadTextFile(answer.filename, answer.text);
    setSaved({ filename: answer.filename, problems: answer.problems });
  };

  return (
    <BundleDialogFrame title={t('bundle.export.title')} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{t('bundle.privacyWarning')}</p>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('bundle.export.templates')}</legend>
        {templates.length === 0 && <p className="text-sm text-muted-foreground">{t('bundle.export.noTemplates')}</p>}
        {templates.map((template) => (
          <label key={template.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!leftOutTemplates.has(template.id)} onChange={() => setLeftOutTemplates((current) => flip(current, template.id))} />
            {template.name}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('bundle.export.blocks')}</legend>
        {blocksStatus === 'loading' && <p className="text-sm text-muted-foreground">{t('bundle.loading')}</p>}
        <ProfileErrorNotice error={blocksError} />
        {blocksStatus === 'ready' && blocks.length === 0 && <p className="text-sm text-muted-foreground">{t('bundle.export.noBlocks')}</p>}
        {blocks.map((block) => (
          <label key={block.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!leftOutBlocks.has(block.id)} onChange={() => setLeftOutBlocks((current) => flip(current, block.id))} />
            {block.name}
          </label>
        ))}
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={includeBlockContent} onChange={(event) => setIncludeBlockContent(event.target.checked)} />
        <span>{t('bundle.export.includeContent')}</span>
      </label>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('bundle.export.format')}</legend>
        {(['yaml', 'json'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input type="radio" name="bundle-export-format" checked={format === value} onChange={() => setFormat(value)} />
            {value === 'yaml' ? t('bundle.export.formatYaml') : t('bundle.export.formatJson')}
          </label>
        ))}
      </fieldset>

      <BundleErrorNotice error={actions.error} />
      {saved && <p className="text-sm">{t('bundle.export.done', { filename: saved.filename })}</p>}
      {saved && saved.problems.length > 0 && (
        <div role="alert" className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">{t('bundle.export.problems')}</p>
          <ul className="list-disc pl-5">{saved.problems.map((problem) => <li key={`${problem.key}-${problem.code}`}>{problem.message}</li>)}</ul>
        </div>
      )}

      <Button type="button" size="sm" disabled={actions.busy || blocksStatus === 'loading' || (templateIds.length === 0 && blockIds.length === 0)} onClick={() => void run()}>
        {actions.busy ? t('bundle.export.running') : t('bundle.export.run')}
      </Button>
    </BundleDialogFrame>
  );
}
