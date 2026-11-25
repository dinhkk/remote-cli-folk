import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/modules/i18n';
import { SelectionDetail } from '@/modules/agent-monitor/usage/SelectionDetail';
import type { Selection } from '@/modules/agent-monitor/running/resolveSelection';
import { makeNode, makeSession } from '@/modules/agent-monitor/tests/monitorFixtures';

afterEach(cleanup);

const MB = 1024 * 1024;
const NOW = 1_065_000;

const session = makeSession({
  id: 's1',
  label: 'Review Alpha',
  projectName: 'Alpha',
  runStartedAt: 1_000_000,
  agentTokens: 1700,
  cacheHitRatio: 0.82,
  orchestrator: { name: 'orchestrator', fromProfile: true, state: 'running', lastToolName: 'Read', contextTokens: 42_000, contextWindow: 200_000 },
  agents: [makeNode({ id: 'a', name: 'coding--alpha', tokens: 1200 }), makeNode({ id: 'b', name: 'qa', tokens: 500 })],
  usage: { cpuPercent: 62.4, rssBytes: 3 * 1024 * MB, processCount: 4 },
});

const show = (selection: Selection) => render(<SelectionDetail selection={selection} now={NOW} />);
const value = (key: string) => screen.getByTestId(`detail-${key}`).textContent;

describe('SelectionDetail', () => {
  it('a session: its state, how long it has run, what its whole process tree uses, its context, cache hit and tokens by agent', () => {
    show({ kind: 'session', session, main: false });
    expect(screen.getByTestId('detail-title').textContent).toBe('Review Alpha');
    expect(value('state')).toBe('Working');
    expect(value('elapsed')).toBe('1:05');
    expect(value('cpu')).toBe('62%');
    expect(value('memory')).toBe('3.0 GB');
    expect(value('processes')).toBe('4');
    expect(value('context')).toBe('42k / 200k');
    expect(value('cache')).toBe('82%');
    expect(value('tokens')).toBe('1.7k');
    const bars = screen.getByTestId('tokens-by-agent');
    expect(within(bars).getByText('coding--alpha')).toBeTruthy();
    expect(within(bars).getByText('qa')).toBeTruthy();
  });

  it('the main agent shows the same numbers under its own name', () => {
    show({ kind: 'session', session, main: true });
    expect(screen.getByTestId('detail-title').textContent).toBe('orchestrator');
    expect(value('cpu')).toBe('62%');
  });

  it('a session whose usage is not known yet shows dashes for CPU, memory and processes, never zeros', () => {
    show({ kind: 'session', session: { ...session, usage: undefined, cacheHitRatio: null, orchestrator: { ...session.orchestrator, contextTokens: null } }, main: false });
    expect(value('cpu')).toBe('—');
    expect(value('memory')).toBe('—');
    expect(value('processes')).toBe('—');
    expect(value('context')).toBe('—');
    expect(value('cache')).toBe('—');
  });

  it('an agent: state, elapsed, tokens, tool calls, token rate, model, current tool and description; no CPU or memory of its own', () => {
    const agent = makeNode({ id: 'a', name: 'coding--alpha', description: 'Fix the bug', tokens: 1200, toolCalls: 3, tokensPerSecond: 50, lastToolName: 'Grep', model: 'claude-sonnet-5-5' });
    show({ kind: 'agent', session, agent });
    expect(screen.getByTestId('detail-title').textContent).toBe('coding--alpha');
    expect(value('state')).toBe('Working');
    expect(value('elapsed')).toBe('1:05');
    expect(value('tokens')).toBe('1.2k');
    expect(value('tools')).toBe('3');
    expect(value('rate')).toBe('50 / s');
    expect(value('model')).toBe('claude-sonnet-5-5');
    expect(value('tool')).toBe('Grep');
    expect(value('description')).toBe('Fix the bug');
    expect(screen.queryByTestId('detail-cpu')).toBeNull();
    expect(screen.queryByTestId('detail-memory')).toBeNull();
  });

  it('a finished agent stops its clock at its end and has no current tool', () => {
    const agent = makeNode({ id: 'a', name: 'qa', state: 'done', startedAt: 1_000_000, endedAt: 1_010_000, lastToolName: 'Grep' });
    show({ kind: 'agent', session, agent });
    expect(value('state')).toBe('Done');
    expect(value('elapsed')).toBe('0:10');
    expect(screen.queryByTestId('detail-tool')).toBeNull();
  });

  it('a process group: its name, how many processes, memory and CPU', () => {
    show({ kind: 'process', session, group: { name: 'node', count: 3, rssBytes: 200 * MB, cpuPercent: 12.4 } });
    expect(screen.getByTestId('detail-title').textContent).toBe('node');
    expect(value('count')).toBe('3');
    expect(value('memory')).toBe('200 MB');
    expect(value('cpu')).toBe('12%');
  });

  it('the unnamed "other" group is worded, and unmeasured CPU is a dash', () => {
    show({ kind: 'process', session, group: { name: '', count: 2, rssBytes: MB, cpuPercent: null } });
    expect(screen.getByTestId('detail-title').textContent).toBe('other processes');
    expect(value('cpu')).toBe('—');
  });
});
