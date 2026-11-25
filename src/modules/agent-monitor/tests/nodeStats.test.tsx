import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { LazyMonitorGraph } from '@/modules/agent-monitor/graph/MonitorGraphLazy';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { makeNode, makeSession } from '@/modules/agent-monitor/tests/monitorFixtures';
import type { AgentMonitorSession } from '@/shared/types';

/**
 * What each box of the graph says about itself as small icon + value chips (the numbers that used to be a line of words).
 * Every chip is named for a screen reader (`role="img"` + `aria-label`, also its tooltip); none is a button.
 */

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const MB = 1024 * 1024;

const SESSION: AgentMonitorSession = makeSession({
  id: 's1',
  label: 'Review Alpha',
  orchestrator: { name: 'orchestrator', fromProfile: true, state: 'running', lastToolName: 'Read', contextTokens: 42_000, contextWindow: 200_000 },
  agents: [
    makeNode({ id: 'a1', name: 'review-code--alpha', tokens: 1200, toolCalls: 3, lastToolName: 'Grep' }),
    makeNode({ id: 'a2', name: 'testing--alpha', state: 'done', startedAt: 1_000_000, endedAt: 1_002_000, tokens: 400, toolCalls: 2 }),
  ],
  processes: [{ name: 'node', count: 3, rssBytes: 200 * MB, cpuPercent: 12.4 }],
  usage: { cpuPercent: 12.4, rssBytes: 340 * MB, processCount: 5 },
});

const draw = async (sessions: AgentMonitorSession[]) => {
  render(<LazyMonitorGraph sessions={sessions} now={1_005_000} animate={false} onSelectNode={vi.fn()} />);
  await findGraph();
};

const chips = (id: string) => within(graphNode(id) as HTMLElement).queryAllByRole('img').map((chip) => chip.getAttribute('aria-label'));

describe('the chips on a box', () => {
  it('a session says how long it ran and what its whole process tree uses', async () => {
    await draw([SESSION]);
    expect(chips('session:s1')).toEqual(['Elapsed 0:05', 'CPU 12%', 'Memory 340 MB']);
  });

  it('a session whose usage is not known yet has no CPU or memory chip, never a zero', async () => {
    await draw([{ ...SESSION, usage: undefined }]);
    expect(chips('session:s1')).toEqual(['Elapsed 0:05']);
    expect(graphNode('session:s1')?.textContent).not.toContain('0%');
  });

  it('a session shows CPU as unmeasured ("—") until the second sample, not 0', async () => {
    await draw([{ ...SESSION, usage: { cpuPercent: null, rssBytes: 340 * MB, processCount: 5 } }]);
    expect(chips('session:s1')).toEqual(['Elapsed 0:05', 'CPU —', 'Memory 340 MB']);
  });

  it('the main agent says how long it works, how much context it holds, and its last tool', async () => {
    await draw([SESSION]);
    expect(chips('orch:s1')).toEqual(['Elapsed 0:05', 'Context 42k']);
    expect(graphNode('orch:s1')?.textContent).toContain('▸ Read');
  });

  it('an agent says elapsed, tokens and tool calls; a finished one stops its clock at its end', async () => {
    await draw([SESSION]);
    expect(chips('agent:s1:a1')).toEqual(['Elapsed 0:05', 'Tokens 1.2k', 'Tool calls 3']);
    expect(chips('agent:s1:a2')).toEqual(['Elapsed 0:02', 'Tokens 400', 'Tool calls 2']);
    expect(graphNode('agent:s1:a1')?.textContent).toContain('▸ Grep');
  });

  it('a process group says how many, how much memory and what CPU', async () => {
    await draw([SESSION]);
    expect(chips('proc:s1:node')).toEqual(['Processes 3', 'Memory 200 MB', 'CPU 12%']);
  });

  it('a process group with unmeasured CPU leaves the CPU chip out', async () => {
    await draw([{ ...SESSION, processes: [{ name: 'node', count: 1, rssBytes: 10 * MB, cpuPercent: null }] }]);
    expect(chips('proc:s1:node')).toEqual(['Processes 1', 'Memory 10.0 MB']);
  });

  it('a chip carries its value as text and is also its own tooltip; no chip is a button', async () => {
    await draw([SESSION]);
    const chip = screen.getAllByRole('img', { name: 'Tokens 1.2k' })[0];
    expect(chip.textContent).toBe('1.2k');
    expect(chip.getAttribute('title')).toBe('Tokens 1.2k');
    for (const id of ['session:s1', 'orch:s1', 'agent:s1:a1', 'proc:s1:node']) {
      expect(within(graphNode(id) as HTMLElement).queryAllByRole('button')).toEqual([]);
    }
  });

  it('keeps the box name and role: the box itself is still the one button', async () => {
    await draw([SESSION]);
    expect(screen.getByRole('button', { name: 'Session Review Alpha: show it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agent review-code--alpha (Working): focus it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Child processes node: 3 running, 200 MB of memory/ })).toBeTruthy();
  });
});
