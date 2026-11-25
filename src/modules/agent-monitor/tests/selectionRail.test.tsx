import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { RunningMonitorPane, useRunningMainPane } from '@/modules/agent-monitor';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { MACHINE, installFakeMonitorApi, makeNode, makeRow, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch } from '@/modules/agent-monitor/tests/runningHarness';

/** The rail next to the graph: the server always, and the numbers of the node the user selected, only while one is. */

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function Main() {
  const pane = useRunningMainPane();
  return pane ? <RunningMonitorPane /> : <div data-testid="route-view" />;
}

const SNAPSHOT = makeSnapshot({
  sessions: [
    makeSession({
      id: 's1',
      label: 'Review Alpha',
      agents: [makeNode({ id: 'tu-1', name: 'review-code--alpha', tokens: 1200, toolCalls: 3 })],
      processes: [{ name: 'node', count: 2, rssBytes: 120 * 1024 * 1024, cpuPercent: 3 }],
      usage: { cpuPercent: 12, rssBytes: 300 * 1024 * 1024, processCount: 3 },
    }),
    makeSession({ id: 's2', label: 'Other', usage: { cpuPercent: 77, rssBytes: 900 * 1024 * 1024, processCount: 2 } }),
  ],
  resources: { sampling: true, intervalMs: 2000, lastSampleAt: 1_004_000, error: null, cores: 8, machine: MACHINE, rows: [makeRow({ key: 'server', kind: 'server', label: 'Server', pid: 10 })] },
});

const mount = async () => {
  stubReducedMotion(true);
  installFakeMonitorApi(() => SNAPSHOT);
  renderRunning(<><RunningTabSwitch /><Main /></>);
  await screen.findByTestId('agent-monitor');
  await findGraph();
};

describe('the rail beside the graph', () => {
  it('is the machine alone in the overview: no number of any session is on screen as text outside the graph', async () => {
    await mount();
    expect(screen.queryByTestId('selection-detail')).toBeNull();
    expect(screen.getByTestId('machine-card')).toBeTruthy();
  });

  it('shows the detail of a selected agent INSTEAD of the machine card, and brings the machine card back when the focus is released', async () => {
    await mount();
    fireEvent.click(graphNode('agent:s1:tu-1') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('selection-detail').dataset.detailKind).toBe('agent'));
    expect(screen.getByTestId('detail-title').textContent).toBe('review-code--alpha');
    expect(screen.getByTestId('detail-tools').textContent).toBe('3');
    expect(screen.queryByTestId('machine-card')).toBeNull();

    fireEvent.click(graphNode('agent:s1:tu-1') as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('selection-detail')).toBeNull());
    expect(screen.getByTestId('machine-card')).toBeTruthy();
  });

  it('shows the numbers of the selected main agent\'s session, not of another session', async () => {
    await mount();
    fireEvent.click(graphNode('orch:s1') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('selection-detail').dataset.detailKind).toBe('session'));
    expect(screen.getByTestId('detail-cpu').textContent).toBe('12%');
    expect(screen.getByTestId('detail-memory').textContent).toBe('300 MB');
  });

  it('shows the detail of a selected process group', async () => {
    localStorage.setItem('agentMonitor.showProcesses', 'true');
    await mount();
    fireEvent.click(graphNode('proc:s1:node') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('selection-detail').dataset.detailKind).toBe('process'));
    expect(screen.getByTestId('detail-count').textContent).toBe('2');
  });
});
