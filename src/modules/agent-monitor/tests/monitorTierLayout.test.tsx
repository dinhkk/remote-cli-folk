import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import type * as UseElementWidthModule from '@/modules/agent-monitor/hooks/useElementWidth';
import { RunningMonitorPane, useRunningMainPane } from '@/modules/agent-monitor';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { MACHINE, installFakeMonitorApi, makeNode, makeRow, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch } from '@/modules/agent-monitor/tests/runningHarness';

/**
 * The pane lays itself out by its OWN width in three tiers. jsdom has no layout, so the width is handed in; what is checked
 * is the structure each tier asks for (classes and DOM order), not pixels: real sizes are looked at in the browser.
 */

const paneWidth = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/modules/agent-monitor/hooks/useElementWidth', async (importOriginal) => ({
  ...(await importOriginal<typeof UseElementWidthModule>()),
  useElementWidth: () => ({ ref: { current: null }, width: paneWidth.value }),
}));

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function Main() {
  const pane = useRunningMainPane();
  return pane ? <RunningMonitorPane /> : <div data-testid="route-view" />;
}

const SNAPSHOT = makeSnapshot({
  sessions: [makeSession({ id: 's1', label: 'Review Alpha', agents: [makeNode({ id: 'tu-1', name: 'review-code--alpha' })] })],
  resources: { sampling: true, intervalMs: 2000, lastSampleAt: 1_004_000, error: null, cores: 8, machine: MACHINE, rows: [makeRow({ key: 'server', kind: 'server', label: 'Server', pid: 10 })] },
});

const mount = async (width: number) => {
  paneWidth.value = width;
  stubReducedMotion(true);
  installFakeMonitorApi(() => SNAPSHOT);
  renderRunning(<><RunningTabSwitch /><Main /></>);
  await screen.findByTestId('agent-monitor');
  await findGraph();
};

const before = (first: HTMLElement, second: HTMLElement) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the overview by pane width', () => {
  it.each([
    [1200, 'wide', 'side-by-side'],
    [800, 'medium', 'rail-below'],
    [360, 'narrow', 'rail-above'],
  ])('at %ipx the pane is %s and lays the rail out %s', async (width, tier, layout) => {
    await mount(width);
    expect(screen.getByTestId('running-pane').dataset.tier).toBe(tier);
    expect(screen.getByTestId('monitor-columns').dataset.layout).toBe(layout);
  });

  it('wide and medium: the graph comes first, the machine card after it', async () => {
    await mount(800);
    expect(before(screen.getByTestId('monitor-graph-card'), screen.getByTestId('machine-card'))).toBe(true);
  });

  it('narrow: the machine card is above the graph, the KPI strip on top of both and its cards smaller', async () => {
    await mount(360);
    expect(before(screen.getByTestId('machine-card'), screen.getByTestId('monitor-graph-card'))).toBe(true);
    expect(before(screen.getByTestId('monitor-kpi-strip'), screen.getByTestId('machine-card'))).toBe(true);
    expect(screen.getByTestId('kpi-agents').className).toContain('p-2');
  });

  it('the KPI strip keeps three cards in every tier', async () => {
    await mount(360);
    expect(screen.getByTestId('monitor-kpi-strip').className).toContain('grid-cols-3');
  });
});

describe('the single-session view by pane width', () => {
  const focusAgent = async () => {
    fireEvent.click(graphNode('agent:s1:tu-1') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('selection-detail')).toBeTruthy());
  };

  it('narrow: the detail of the tapped box appears ABOVE the graph, so it is seen without scrolling past it', async () => {
    await mount(360);
    await focusAgent();
    expect(before(screen.getByTestId('selection-detail'), screen.getByTestId('monitor-graph-card'))).toBe(true);
    expect(screen.getByTestId('monitor-columns').dataset.layout).toBe('rail-above');
  });

  it('medium: the graph, then the detail under it (the machine card is gone: one session shows its own numbers)', async () => {
    await mount(800);
    await focusAgent();
    expect(before(screen.getByTestId('monitor-graph-card'), screen.getByTestId('selection-detail'))).toBe(true);
    expect(screen.queryByTestId('machine-card')).toBeNull();
  });

  it('wide: graph and rail side by side', async () => {
    await mount(1200);
    await focusAgent();
    expect(screen.getByTestId('monitor-columns').dataset.layout).toBe('side-by-side');
  });
});
