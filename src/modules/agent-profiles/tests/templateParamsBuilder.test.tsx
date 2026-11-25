import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/modules/i18n';
import { TemplateParamsBuilder } from '@/modules/agent-profiles/templates/TemplateParamsBuilder';
import { TemplatePlaceholderCheck } from '@/modules/agent-profiles/templates/TemplatePlaceholderCheck';
import type { AgentProfileParam } from '@/shared/types';

/** Schema builder (UI-T2) and the `{{key}}` check (UI-T3, UI-T4). */

const param = (key: string, extra: Partial<AgentProfileParam> = {}): AgentProfileParam => ({
  key, type: 'text', title: key, description: '', required: false, ...extra,
});

/** Holds the params like the editor does, and exposes the latest value to assert on. */
function Harness({ initial, onValue }: { initial: AgentProfileParam[]; onValue: (params: AgentProfileParam[]) => void }) {
  const [params, setParams] = useState(initial);
  onValue(params);
  return <TemplateParamsBuilder params={params} onChange={setParams} />;
}

const setup = (initial: AgentProfileParam[]) => {
  let latest = initial;
  render(<Harness initial={initial} onValue={(params) => { latest = params; }} />);
  return { value: () => latest };
};

describe('schema builder', () => {
  it('adds an empty text parameter and edits its fields', () => {
    const { value } = setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));

    const row = screen.getByRole('group', { name: 'Parameter 1' });
    fireEvent.change(within(row).getByLabelText('Key'), { target: { value: 'git_url' } });
    fireEvent.change(within(row).getByLabelText('Type'), { target: { value: 'url' } });
    fireEvent.change(within(row).getByLabelText('Title'), { target: { value: 'Git URL' } });
    fireEvent.change(within(row).getByLabelText('Default value'), { target: { value: 'https://x' } });
    fireEvent.click(within(row).getByLabelText('Required'));

    expect(value()).toEqual([{ key: 'git_url', type: 'url', title: 'Git URL', description: '', required: true, default: 'https://x' }]);
  });

  it('removes and reorders parameters', () => {
    const { value } = setup([param('a'), param('b'), param('c')]);

    fireEvent.click(within(screen.getByRole('group', { name: 'Parameter 3' })).getByRole('button', { name: 'Move up' }));
    expect(value().map((entry) => entry.key)).toEqual(['a', 'c', 'b']);

    fireEvent.click(within(screen.getByRole('group', { name: 'Parameter 1' })).getByRole('button', { name: 'Remove parameter' }));
    expect(value().map((entry) => entry.key)).toEqual(['c', 'b']);
  });

  it('cannot move the first parameter up or the last one down', () => {
    setup([param('a'), param('b')]);
    expect((within(screen.getByRole('group', { name: 'Parameter 1' })).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByRole('group', { name: 'Parameter 2' })).getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('flags an invalid, a reserved and a duplicate key on its own row', () => {
    setup([param('1bad'), param('project_name'), param('same'), param('same')]);

    expect(within(screen.getByRole('group', { name: 'Parameter 1' })).getByRole('alert').textContent).toContain('must start with a letter');
    expect(within(screen.getByRole('group', { name: 'Parameter 2' })).getByRole('alert').textContent).toContain('filled by the project');
    expect(within(screen.getByRole('group', { name: 'Parameter 3' })).getByRole('alert').textContent).toContain('already uses this key');
    expect(within(screen.getByRole('group', { name: 'Parameter 4' })).getByRole('alert').textContent).toContain('already uses this key');
  });

  it('shows an empty-state hint without parameters', () => {
    setup([]);
    expect(screen.getByText(/No parameters/)).toBeTruthy();
  });
});

describe('{{key}} check', () => {
  it('gives a red error with a one-click fix for a key that has no parameter', () => {
    const added: string[] = [];
    render(<TemplatePlaceholderCheck instructions="Use {{git_url}} and {{guideline}}" params={[param('guideline')]} onAddParam={(key) => added.push(key)} />);

    expect(screen.getByRole('alert').textContent).toContain('{{git_url}}');
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter "git_url"' }));
    expect(added).toEqual(['git_url']);
  });

  it('only warns (status, not alert) about a parameter that nothing uses', () => {
    render(<TemplatePlaceholderCheck instructions="No keys here" params={[param('extra')]} onAddParam={() => undefined} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('"extra" is not used');
  });

  it('is silent when keys and parameters match, reserved project keys included', () => {
    const { container } = render(<TemplatePlaceholderCheck instructions="{{project_name}} {{x}}" params={[param('x')]} onAddParam={() => undefined} />);
    expect(container.textContent).toBe('');
  });
});
