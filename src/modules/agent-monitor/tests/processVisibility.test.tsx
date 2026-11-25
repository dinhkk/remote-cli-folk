import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { RunningMonitorPane, useRunningMainPane } from '@/modules/agent-monitor';
import { SHOW_PROCESSES_KEY } from '@/modules/agent-monitor/hooks/useShowProcesses';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { installFakeMonitorApi, makeNode, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch } from '@/modules/agent-monitor/tests/runningHarness';

/** The one switch that hides or shows the child OS processes of every session in the graph; hidden until the user turns it on. */

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function Main() {
  const pane = useRunningMainPane();
  return pane ? <RunningMonitorPane /> : <div data-testid="route-view" />;
}

const SNAPSHOT = makeSnapshot({
  sessions: [
    makeSession({
      id: 's1',
      label: 'Review Alpha',
      agents: [makeNode({ id: 'tu-1', name: 'review-code--alpha' })],
      processes: [{ name: 'node', count: 2, rssBytes: 120 * 1024 * 1024, cpuPercent: 3 }],
    }),
  ],
});

const mount = async (showProcesses: boolean) => {
  stubReducedMotion(true);
  installFakeMonitorApi(() => SNAPSHOT);
  renderRunning(<><RunningTabSwitch /><Main /></>, '/', {}, { showProcesses });
  await screen.findByTestId('agent-monitor');
  await findGraph();
};

describe('the process toggle on the graph card', () => {
  it('draws no process box until the user turns the switch on, and remembers it', async () => {
    await mount(false);
    expect(graphNode('agent:s1:tu-1')).not.toBeNull();
    expect(graphNode('proc:s1:node')).toBeNull();
    expect(screen.queryByTestId('monitor-graph-omitted-processes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show child processes' }));
    await waitFor(() => expect(graphNode('proc:s1:node')).not.toBeNull());
    expect(localStorage.getItem(SHOW_PROCESSES_KEY)).toBe('true');
    expect(screen.getByRole('button', { name: 'Hide child processes' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide child processes' }));
    await waitFor(() => expect(graphNode('proc:s1:node')).toBeNull());
    expect(localStorage.getItem(SHOW_PROCESSES_KEY)).toBe('false');
  });

  it('lets go of a focused process box when the processes are hidden, back to the overview', async () => {
    await mount(true);
    fireEvent.click(graphNode('proc:s1:node') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('running-pane').dataset.pane).toBe('graph'));

    fireEvent.click(screen.getByRole('button', { name: 'Hide child processes' }));
    await waitFor(() => expect(screen.getByTestId('running-pane').dataset.pane).toBe('overview'));
  });

  it('keeps an agent focus when the processes are hidden', async () => {
    await mount(true);
    fireEvent.click(graphNode('agent:s1:tu-1') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('running-pane').dataset.pane).toBe('graph'));

    fireEvent.click(screen.getByRole('button', { name: 'Hide child processes' }));
    await waitFor(() => expect(graphNode('proc:s1:node')).toBeNull());
    expect(screen.getByTestId('running-pane').dataset.pane).toBe('graph');
  });
});
