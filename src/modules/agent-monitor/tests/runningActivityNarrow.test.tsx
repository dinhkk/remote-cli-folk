import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import type * as UseElementWidthModule from '@/modules/agent-monitor/hooks/useElementWidth';
import { RunningMonitorPane, useRunningMainPane, type RunningActivityContext } from '@/modules/agent-monitor';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { installFakeMonitorApi, makeNode, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch } from '@/modules/agent-monitor/tests/runningHarness';

/**
 * On a NARROW pane (under 640 px) the Activity of a sub-agent is its own view: the detail card above the graph has an
 * "Activity" button, the view replaces the pane's content, and Back returns to the graph with the same box focused. On a
 * medium or wide pane the Activity stays under the graph and no button is drawn. jsdom has no layout: the width is handed in.
 */

const paneWidth = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/modules/agent-monitor/hooks/useElementWidth', async (importOriginal) => ({
  ...(await importOriginal<typeof UseElementWidthModule>()),
  useElementWidth: () => ({ ref: { current: null }, width: paneWidth.value }),
}));

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const SESSIONS = [
  makeSession({ id: 's1', agents: [makeNode({ id: 'tu-1', name: 'review' }), makeNode({ id: 'tu-2', name: 'second' })] }),
  makeSession({ id: 't1', source: 'terminal', detail: 'transcript', openSessionId: null, agents: [makeNode({ id: 'tu-9', name: 'term' })] }),
];

const seen: RunningActivityContext[] = [];

function Main() {
  const pane = useRunningMainPane();
  return pane
    ? <RunningMonitorPane renderActivity={(context) => { seen.push(context); return <p data-testid="activity-stub">{context.agentId}</p>; }} />
    : <div data-testid="route-view" />;
}

const mount = async (width: number) => {
  seen.length = 0;
  paneWidth.value = width;
  stubReducedMotion(true);
  installFakeMonitorApi(() => makeSnapshot({ sessions: SESSIONS }));
  renderRunning(<><RunningTabSwitch /><Main /></>);
  await screen.findByTestId('agent-monitor');
  await findGraph();
};

const focus = async (nodeId: string) => {
  fireEvent.click(graphNode(nodeId)!);
  await waitFor(() => expect(graphNode(nodeId)?.getAttribute('data-node-focused')).toBe('true'));
};

describe('a narrow pane', () => {
  it('draws no Activity under the graph; the sub-agent\'s detail card has an Activity button instead', async () => {
    await mount(360);
    await focus('agent:s1:tu-1');
    expect(screen.queryByTestId('running-activity')).toBeNull();
    expect(seen).toHaveLength(0);
    expect(await screen.findByTestId('detail-open-activity')).toBeTruthy();
  });

  it('the button swaps the pane for the Activity alone (no graph, no detail card) with a Back button, filling the view', async () => {
    await mount(360);
    await focus('agent:s1:tu-1');
    fireEvent.click(await screen.findByTestId('detail-open-activity'));

    const section = await screen.findByTestId('running-activity');
    expect(section.dataset.activityView).toBe('full');
    expect(screen.getByTestId('activity-stub').textContent).toBe('tu-1');
    expect(seen.at(-1)).toMatchObject({ sessionKey: 's1', agentId: 'tu-1', fill: true });
    expect(screen.queryByTestId('monitor-graph-card')).toBeNull();
    expect(screen.queryByTestId('selection-detail')).toBeNull();
    expect(screen.getByTestId('activity-back').className).toContain('min-h-[44px]');
  });

  it('Back returns to the graph with the same box still focused, and the button is there again', async () => {
    await mount(360);
    await focus('agent:s1:tu-1');
    fireEvent.click(await screen.findByTestId('detail-open-activity'));
    fireEvent.click(await screen.findByTestId('activity-back'));

    await findGraph();
    expect(screen.queryByTestId('running-activity')).toBeNull();
    expect(screen.queryByTestId('activity-back')).toBeNull();
    await waitFor(() => expect(graphNode('agent:s1:tu-1')?.getAttribute('data-node-focused')).toBe('true'));
    expect(screen.getByTestId('detail-open-activity')).toBeTruthy();
  });

  it('after Back, another sub-agent starts on the graph: its Activity needs its own button press and shows that agent', async () => {
    await mount(360);
    await focus('agent:s1:tu-1');
    fireEvent.click(await screen.findByTestId('detail-open-activity'));
    fireEvent.click(await screen.findByTestId('activity-back'));
    await findGraph();

    await focus('agent:s1:tu-2');
    expect(screen.queryByTestId('running-activity')).toBeNull();
    fireEvent.click(await screen.findByTestId('detail-open-activity'));
    expect(screen.getByTestId('activity-stub').textContent).toBe('tu-2');
  });

  it('has no button for the main agent (it has no Activity; a terminal session\'s agent is covered by activityTarget)', async () => {
    await mount(360);
    await focus('orch:s1');
    expect(await screen.findByTestId('selection-detail')).toBeTruthy();
    expect(screen.queryByTestId('detail-open-activity')).toBeNull();
  });
});

describe('a medium or wide pane', () => {
  it.each([800, 1200])('keeps the Activity under the graph at %ipx and draws no Activity button', async (width) => {
    await mount(width);
    await focus('agent:s1:tu-1');
    const section = await screen.findByTestId('running-activity');
    expect(section.dataset.activityView).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ agentId: 'tu-1', fill: false });
    expect(screen.queryByTestId('detail-open-activity')).toBeNull();
    expect(screen.queryByTestId('activity-back')).toBeNull();
    expect(screen.getByTestId('monitor-graph-card')).toBeTruthy();
  });
});
