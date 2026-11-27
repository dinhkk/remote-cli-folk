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
    [1200, 'wide', 'grid-cols-4'],
    [800, 'medium', 'grid-cols-4'],
    [500, 'narrow', 'grid-cols-3'],
    [360, 'narrow', 'grid-cols-3'],
    [320, 'narrow', 'grid-cols-1'],
  ])('at %ipx the pane is %s and the strip has %s', async (width, tier, columns) => {
    await mount(width);
    expect(screen.getByTestId('running-pane').dataset.tier).toBe(tier);
    expect(screen.getByTestId('monitor-kpi-strip').className).toContain(columns);
  });

  it('every tier: the strip holds the machine card and sits above the full-width graph', async () => {
    await mount(800);
    const strip = screen.getByTestId('monitor-kpi-strip');
    expect(strip.contains(screen.getByTestId('machine-card'))).toBe(true);
    expect(before(strip, screen.getByTestId('monitor-graph-card'))).toBe(true);
    expect(screen.queryByTestId('monitor-columns')).toBeNull();
  });

  it('narrow: the strip, then the graph (never above it), and the machine card spans a row of its own', async () => {
    await mount(500);
    expect(before(screen.getByTestId('monitor-kpi-strip'), screen.getByTestId('monitor-graph-card'))).toBe(true);
    expect(screen.getByTestId('kpi-agents').className).toContain('p-2');
    expect(screen.getByTestId('machine-card').parentElement?.className).toContain('col-span-3');
  });
});

describe('the single-session view by pane width', () => {
  const focusAgent = async () => {
    fireEvent.click(graphNode('agent:s1:tu-1') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('selection-detail')).toBeTruthy());
  };

  it('narrow: the detail of the tapped box appears UNDER the graph', async () => {
    await mount(360);
    await focusAgent();
    expect(before(screen.getByTestId('monitor-graph-card'), screen.getByTestId('selection-detail'))).toBe(true);
    expect(screen.getByTestId('monitor-columns').dataset.layout).toBe('rail-below');
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
