import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import type { NewChatScopeState } from '@/modules/agent-profiles';
import ComposerAgentMenu from '@/modules/chat/composer/ComposerAgentMenu';

/**
 * The composer's main-agent dropdown (next to `/`, in the style of the model menu): `Auto` plus the agents the project
 * offers, the button shows the current choice, picking closes the menu, and with nothing to choose it renders nothing.
 * The state comes from `useNewChatScope` (its own tests); here it is a stub.
 */

const agents = [
  { name: 'orchestrator', source: 'project' as const, isOrchestrator: true },
  { name: 'review-code', source: 'project' as const, isOrchestrator: false },
];

const stateOf = (patch: Partial<NewChatScopeState> = {}): NewChatScopeState => ({
  status: 'ready',
  agents,
  agentName: null,
  setAgentName: vi.fn(),
  request: { scope: { agentName: null } },
  ...patch,
});

const button = () => screen.queryByRole('button', { name: /^Main agent/ });
const open = () => fireEvent.click(button()!);
const rows = () => screen.getAllByRole('menuitemradio');

describe('composer main-agent menu', () => {
  it('shows Auto on the button by default and the agents in the menu, orchestrator marked', () => {
    render(<ComposerAgentMenu state={stateOf()} />);

    expect(button()?.textContent).toBe('Auto');
    open();
    expect(screen.getByRole('menu', { name: 'Main agent' })).toBeTruthy();
    expect(rows().map((row) => row.querySelector('.truncate')?.textContent)).toEqual(['Auto', 'orchestrator (orchestrator)', 'review-code']);
    expect(screen.getByText('Claude Code picks an agent for each task')).toBeTruthy();
    expect(rows().map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('shows the chosen agent on the button and checks its row', () => {
    render(<ComposerAgentMenu state={stateOf({ agentName: 'review-code' })} />);

    expect(button()?.textContent).toBe('review-code');
    open();
    expect(rows().map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  });

  it('picking an agent reports it and closes the menu; picking Auto reports null', () => {
    const state = stateOf({ agentName: 'review-code' });
    render(<ComposerAgentMenu state={state} />);

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^orchestrator/ }));
    expect(state.setAgentName).toHaveBeenLastCalledWith('orchestrator');
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Auto/ }));
    expect(state.setAgentName).toHaveBeenLastCalledWith(null);
  });

  describe('groups', () => {
    const grouped = [
      { name: 'reviewer', source: 'user' as const, isOrchestrator: false, group: 'Work' },
      { name: 'orchestrator', source: 'project' as const, isOrchestrator: true },
      { name: 'coding', source: 'user' as const, isOrchestrator: false, group: 'Work' },
      { name: 'planner', source: 'user' as const, isOrchestrator: false },
      { name: 'ops-helper', source: 'user' as const, isOrchestrator: false, group: 'Ops' },
    ];

    const agentsIn = (name: string) =>
      Array.from(screen.getByRole('group', { name }).querySelectorAll('[role=menuitemradio]')).map((row) => row.querySelector('.truncate')?.textContent);
    const headings = () => within(screen.getByRole('menu', { name: 'Main agent' })).getAllByRole('button').map((heading) => heading.querySelector('.truncate')?.textContent);
    const heading = (name: string) => within(screen.getByRole('group', { name })).getAllByRole('button')[0];

    it('lists named groups alphabetically, then System last for agents without one; Auto stays above every group', () => {
      render(<ComposerAgentMenu state={stateOf({ agents: grouped })} />);
      open();

      expect(headings()).toEqual(['Ops', 'Work', 'System']);
      expect(agentsIn('Work')).toEqual(['reviewer', 'coding']);
      expect(agentsIn('Ops')).toEqual(['ops-helper']);
      expect(rows()[0].querySelector('.truncate')?.textContent).toBe('Auto');
    });

    it('starts with named groups expanded and System collapsed; a heading toggles its group and shows its count', () => {
      render(<ComposerAgentMenu state={stateOf({ agents: grouped })} />);
      open();

      expect(['Ops', 'Work', 'System'].map((name) => heading(name).getAttribute('aria-expanded'))).toEqual(['true', 'true', 'false']);
      expect(agentsIn('System')).toEqual([]);
      expect(heading('System').textContent).toContain('2');

      fireEvent.click(heading('System'));
      expect(heading('System').getAttribute('aria-expanded')).toBe('true');
      expect(agentsIn('System')).toEqual(['orchestrator (orchestrator)', 'planner']);

      fireEvent.click(heading('Work'));
      expect(agentsIn('Work')).toEqual([]);
      expect(agentsIn('Ops')).toEqual(['ops-helper']);
    });

    it('keeps a toggled group as left when the menu is closed and opened again', () => {
      render(<ComposerAgentMenu state={stateOf({ agents: grouped })} />);
      open();
      fireEvent.click(heading('Work'));
      fireEvent.keyDown(window, { key: 'Escape' });

      open();
      expect(heading('Work').getAttribute('aria-expanded')).toBe('false');
      expect(heading('System').getAttribute('aria-expanded')).toBe('false');
    });

    it('indents the agents under a heading', () => {
      render(<ComposerAgentMenu state={stateOf({ agents: grouped })} />);
      open();
      const work = screen.getByRole('group', { name: 'Work' });
      expect(Array.from(work.querySelectorAll('[role=menuitemradio]')).every((row) => row.className.includes('pl-6'))).toBe(true);
      expect(rows()[0].className).not.toContain('pl-6');
    });

    it('treats a group literally named System as the System group, whatever its case', () => {
      render(<ComposerAgentMenu state={stateOf({ agents: [...grouped, { name: 'extra', source: 'user', isOrchestrator: false, group: 'system' }] })} />);
      open();
      expect(screen.getAllByText('System')).toHaveLength(1);
      expect(screen.queryByText('system')).toBeNull();
      fireEvent.click(heading('System'));
      expect(agentsIn('System')).toEqual(['orchestrator (orchestrator)', 'planner', 'extra']);
    });

    it('shows no heading when every agent is in one group, and picking inside a group reports the agent', () => {
      const state = stateOf({ agents });
      render(<ComposerAgentMenu state={state} />);
      open();
      expect(screen.queryByText('System')).toBeNull();
      expect(screen.queryByRole('group', { name: 'System' })).toBeNull();

      fireEvent.click(screen.getByRole('menuitemradio', { name: /^review-code/ }));
      expect(state.setAgentName).toHaveBeenLastCalledWith('review-code');
    });
  });

  it('closes on Escape', () => {
    render(<ComposerAgentMenu state={stateOf()} />);
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders nothing while loading, after an error, when unused, or when the project has no agents', () => {
    for (const patch of [{ status: 'loading' }, { status: 'error' }, { status: 'idle' }, { agents: [] }] as Array<Partial<NewChatScopeState>>) {
      const view = render(<ComposerAgentMenu state={stateOf(patch)} />);
      expect(button()).toBeNull();
      view.unmount();
    }
  });
});
