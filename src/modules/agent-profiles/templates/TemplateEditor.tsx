import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilityFields } from '@/modules/agent-profiles/common/CapabilityFields';
import { ProfileErrorNotice } from '@/modules/agent-profiles/common/ProfileErrorNotice';
import { ProfileField } from '@/modules/agent-profiles/common/ProfileField';
import { ProfileSwitch } from '@/modules/agent-profiles/common/ProfileSwitch';
import { useProfileAction } from '@/modules/agent-profiles/hooks/useProfileAction';
import { TemplateParamsBuilder } from '@/modules/agent-profiles/templates/TemplateParamsBuilder';
import { TemplatePlaceholderCheck } from '@/modules/agent-profiles/templates/TemplatePlaceholderCheck';
import { TemplatePreview } from '@/modules/agent-profiles/templates/TemplatePreview';
import { api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { analyzeTemplatePlaceholders, findParamKeyProblem, isValidProfileSlug, slugifyProfileName } from '@/shared/utils';
import type {
  AgentProfileCapabilities,
  AgentProfileFamily,
  AgentProfileMemoryScope,
  AgentProfileParam,
  AgentProfileTemplate,
  AgentProfileTemplateInput,
  ProfileCatalogs,
} from '@/shared/types';

type TemplateEditorProps = {
  /** The template being edited, or null to create a new one. */
  template: AgentProfileTemplate | null;
  templates: AgentProfileTemplate[];
  catalogs: ProfileCatalogs;
  /** Called after a successful save so the panel can reload and close the editor. */
  onSaved: () => void;
  onCancel: () => void;
  /** Reloads the records after a stale-write conflict. */
  onReload: () => void;
};

/** The agent memory choices of the select; the empty one means "no memory". */
const MEMORY_SCOPES: AgentProfileMemoryScope[] = ['project', 'user', 'local'];

/** The part of a template the capability pickers edit, from stored lists (absent = not set). */
const capabilitiesOf = (source: Partial<AgentProfileTemplateInput> | null): AgentProfileCapabilities => ({
  tools: source?.tools ?? [],
  disallowedTools: source?.disallowedTools ?? [],
  mcpServers: source?.mcpServers ?? [],
  skills: source?.skills ?? [],
  model: source?.model ?? '',
});

/**
 * The template editor of the Templates tab: name and slug, family, "when to use" description, instructions with the
 * `{{key}}` check, the parameter schema builder, tool/MCP/skill/model pickers, the optional agent memory scope, the memory blocks
 * switch and a preview. Saving is blocked on missing keys or invalid fields. Changes reach agent files only when they are generated again.
 * Used by the Templates tab.
 */
export function TemplateEditor({ template, templates, catalogs, onSaved, onCancel, onReload }: TemplateEditorProps) {
  const { t } = useTranslation('agentProfiles');
  const { error, busy, run } = useProfileAction();
  // The form fields below are initialized once from the template and edited locally until Save.
  // The template's display name; the slug follows it until typed by hand.
  const [name, setName] = useState(template?.name ?? '');
  // A slug typed by hand; null means "follow the name" so a new template gets a fitting slug without extra clicks.
  const [slugOverride, setSlugOverride] = useState<string | null>(template ? template.slug : null);
  // Orchestrator or worker; decides how the template is used in a session.
  const [family, setFamily] = useState<AgentProfileFamily>(template?.family ?? 'worker');
  // "When to use it": what the orchestrator reads to pick agents made from this template.
  const [description, setDescription] = useState(template?.description ?? '');
  // The prompt text with `{{key}}` placeholders; the placeholder check reads it live.
  const [instructions, setInstructions] = useState(template?.instructions ?? '');
  // The parameter schema being built.
  const [params, setParams] = useState<AgentProfileParam[]>(template?.params ?? []);
  // Allowed/denied tools, MCP servers, skills and model chosen with the pickers.
  const [capabilities, setCapabilities] = useState<AgentProfileCapabilities>(capabilitiesOf(template));
  // Claude Code agent memory scope written into the generated file; '' = none.
  const [memory, setMemory] = useState<AgentProfileMemoryScope | ''>(template?.memory ?? '');
  // Whether agents made from this template use the app's memory blocks (adds the three block tools and an instruction on Generate).
  const [usesBlocks, setUsesBlocks] = useState(template?.usesBlocks === true);
  // Heading of the new-chat main-agent dropdown the agents of this template are listed under; '' = none ("System").
  const [group, setGroup] = useState(template?.group ?? '');
  // Whether the preview is open; it only matters to the user while checking the prompt.
  const [showPreview, setShowPreview] = useState(false);

  const slug = slugOverride ?? slugifyProfileName(name);
  const slugTaken = templates.some((other) => other.id !== template?.id && other.slug === slug);
  const slugProblem = !isValidProfileSlug(slug) ? t('template.slugInvalid') : slugTaken ? t('template.slugTaken') : null;
  const keys = params.map((param) => param.key);
  const { missing } = analyzeTemplatePlaceholders(instructions, keys);
  const keyProblem = keys.some((_, index) => findParamKeyProblem(keys, index) !== null);
  const blocked = !name.trim() || !instructions.trim() || Boolean(slugProblem) || missing.length > 0 || keyProblem;

  const save = async () => {
    const input: AgentProfileTemplateInput = {
      slug,
      family,
      name: name.trim(),
      description: description.trim(),
      instructions,
      params: params.map((param) => ({
        key: param.key,
        type: param.type,
        title: param.title,
        description: param.description,
        required: param.required,
        ...(param.default ? { default: param.default } : {}),
      })),
      bindings: template?.bindings ?? { project: true, knowledge: false },
      // Empty pickers are left out: an absent field means "not set" on the server.
      ...(capabilities.tools.length > 0 ? { tools: capabilities.tools } : {}),
      ...(capabilities.disallowedTools.length > 0 ? { disallowedTools: capabilities.disallowedTools } : {}),
      ...(capabilities.mcpServers.length > 0 ? { mcpServers: capabilities.mcpServers } : {}),
      ...(capabilities.skills.length > 0 ? { skills: capabilities.skills } : {}),
      ...(capabilities.model ? { model: capabilities.model } : {}),
      ...(memory ? { memory } : {}),
      // Stored only when on: leaving it out switches it off, as for `memory`.
      ...(usesBlocks ? { usesBlocks: true } : {}),
      ...(group.trim() ? { group: group.trim() } : {}),
    };
    const saved = await run(async () => readApiJson(await (template
      ? api.agentProfiles.updateTemplate(template.id, { ...input, rev: template.rev })
      : api.agentProfiles.createTemplate(input))));
    if (saved !== undefined) onSaved();
  };

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h4 className="text-base font-semibold">{template ? t('template.editTitle', { name: template.name }) : t('template.newTitle')}</h4>
      {template && <p role="status" className="rounded-md border border-border bg-muted/40 p-2 text-xs">{t('template.regenerateNote')}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProfileField label={t('template.name')} htmlFor="template-name">
          <Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} />
        </ProfileField>
        <ProfileField label={t('template.slug')} htmlFor="template-slug" error={slugProblem} hint={t('template.slugHint')}>
          <Input id="template-slug" value={slug} onChange={(event) => setSlugOverride(event.target.value)} />
        </ProfileField>
      </div>
      <ProfileField label={t('template.group')} htmlFor="template-group" hint={t('template.groupHint')}>
        <Input id="template-group" value={group} maxLength={40} onChange={(event) => setGroup(event.target.value)} />
      </ProfileField>
      <ProfileField label={t('template.family')} htmlFor="template-family">
        <select
          id="template-family"
          value={family}
          onChange={(event) => setFamily(event.target.value as AgentProfileFamily)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="orchestrator">{t('family.orchestrator')}</option>
          <option value="worker">{t('family.worker')}</option>
        </select>
      </ProfileField>
      <ProfileField label={t('template.description')} htmlFor="template-description" hint={t('template.descriptionHint')}>
        <textarea id="template-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
      </ProfileField>
      <ProfileField label={t('template.instructions')} htmlFor="template-instructions" hint={t('template.instructionsHint', { example: '{{key}}' })}>
        <textarea id="template-instructions" rows={10} value={instructions} onChange={(event) => setInstructions(event.target.value)} className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs" />
      </ProfileField>
      <TemplatePlaceholderCheck
        instructions={instructions}
        params={params}
        onAddParam={(key) => setParams([...params, { key, type: 'text', title: key, description: '', required: false }])}
      />

      <section className="space-y-2">
        <h5 className="text-sm font-semibold">{t('template.paramsTitle')}</h5>
        <TemplateParamsBuilder params={params} onChange={setParams} />
      </section>

      <section className="space-y-2">
        <h5 className="text-sm font-semibold">{t('template.capabilitiesTitle')}</h5>
        <CapabilityFields value={capabilities} onChange={setCapabilities} catalogs={catalogs} showSkills isOrchestrator={family === 'orchestrator'} />
        <ProfileField label={t('template.memory')} htmlFor="template-memory" hint={t('template.memoryHint')}>
          <select
            id="template-memory"
            value={memory}
            onChange={(event) => setMemory(event.target.value as AgentProfileMemoryScope | '')}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">{t('template.memoryNone')}</option>
            {MEMORY_SCOPES.map((scope) => <option key={scope} value={scope}>{t(`template.memoryScope.${scope}`)}</option>)}
          </select>
        </ProfileField>
        <div className="flex items-start gap-3">
          <ProfileSwitch checked={usesBlocks} onChange={setUsesBlocks} ariaLabel={t('template.usesBlocks')} />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{t('template.usesBlocks')}</p>
            <p className="text-xs text-muted-foreground">{t('template.usesBlocksHint')}</p>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <Button type="button" size="sm" variant="outline" aria-expanded={showPreview} onClick={() => setShowPreview((open) => !open)}>
          {showPreview ? t('template.hidePreview') : t('template.showPreview')}
        </Button>
        {showPreview && <TemplatePreview instructions={instructions} params={params} />}
      </section>

      <ProfileErrorNotice error={error} onReload={onReload} />
      <div className="flex gap-2">
        <Button type="submit" disabled={blocked || busy}>{t('actions.save')}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button>
      </div>
    </form>
  );
}
