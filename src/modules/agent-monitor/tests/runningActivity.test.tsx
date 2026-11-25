import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { RunningMonitorPane, useRunningMainPane, type RunningActivityContext } from '@/modules/agent-monitor';
import { activityTarget } from '@/modules/agent-monitor/running/activityTarget';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { installFakeMonitorApi, makeNode, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch, Where } from '@/modules/agent-monitor/tests/runningHarness';

/**
 * The Activity section of the Running pane: which focus asks for it (a sub-agent box of a session that has a chat), what the
 * workspace's slot is handed, and that a pane without a slot, or any other focus, shows none. What the slot draws (the
 * inspector) is project-workspace's and is tested there.
 */

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SESSIONS = [
  makeSession({ id: 's1', agents: [makeNode({ id: 'tu-1', name: 'review' }), makeNode({ id: 'tu-2', name: 'old', state: 'done', endedAt: 1_004_000 })] }),
  makeSession({ id: 't1', source: 'terminal', detail: 'transcript', openSessionId: null, agents: [makeNode({ id: 'tu-9' })] }),
];

describe('activityTarget', () => {
  it('names the sub-agent, its chat and whether it still runs, for a sub-agent box of a session with a chat', () => {
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: 'agent:s1:tu-1' })).toEqual({ sessionKey: 's1', chatId: 's1', agentId: 'tu-1', running: true });
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: 'agent:s1:tu-2' })).toEqual({ sessionKey: 's1', chatId: 's1', agentId: 'tu-2', running: false });
  });

  it('is null for every other focus: no focus, the session, the main agent, a process group, a terminal session, a box that has left, or another session\'s box', () => {
    expect(activityTarget(SESSIONS, null)).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: null })).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: 'orch:s1' })).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: 'proc:s1:node' })).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 't1', nodeKey: 'agent:t1:tu-9' })).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: 'agent:s1:gone' })).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 's1', nodeKey: 'agent:other:tu-1' })).toBeNull();
    expect(activityTarget(SESSIONS, { sessionKey: 'missing', nodeKey: 'agent:missing:tu-1' })).toBeNull();
  });
});

type MainProps = { renderActivity?: (context: RunningActivityContext) => React.ReactNode };

/** What the workspace does: the pane while the Running tab asks for one, else the route's own view. */
function Main({ renderActivity }: MainProps) {
  const pane = useRunningMainPane();
  return pane ? <RunningMonitorPane renderActivity={renderActivity} /> : <div data-testid="route-view" />;
}

const mount = async (renderActivity?: MainProps['renderActivity']) => {
  stubReducedMotion(true);
  installFakeMonitorApi(() => makeSnapshot({ sessions: SESSIONS }));
  renderRunning(<><RunningTabSwitch /><Main renderActivity={renderActivity} /><Where /></>);
  await screen.findByTestId('agent-monitor');
  await findGraph();
};

describe('the pane\'s Activity section', () => {
  it('is handed the focused sub-agent and drawn below the graph', async () => {
    const seen: RunningActivityContext[] = [];
    await mount((context) => { seen.push(context); return <p data-testid="activity-stub">{context.agentId}</p>; });
    expect(screen.queryByTestId('running-activity')).toBeNull();

    fireEvent.click(graphNode('agent:s1:tu-1')!);
    const section = await screen.findByTestId('running-activity');
    expect(section.textContent).toContain('tu-1');
    expect(seen.at(-1)).toMatchObject({ sessionKey: 's1', chatId: 's1', agentId: 'tu-1', running: true });
    const graph = screen.getByTestId('monitor-graph-card');
    expect(graph.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not drawn for the main agent, the session or a terminal session\'s agent', async () => {
    const renderActivity = vi.fn(() => <p data-testid="activity-stub" />);
    await mount(renderActivity);

    fireEvent.click(graphNode('orch:s1')!);
    await waitFor(() => expect(screen.getByTestId('running-pane').dataset.pane).toBe('graph'));
    expect(screen.queryByTestId('running-activity')).toBeNull();
    expect(renderActivity).not.toHaveBeenCalled();
  });

  it('draws nothing when the workspace gives the pane no slot', async () => {
    await mount();
    fireEvent.click(graphNode('agent:s1:tu-1')!);
    await waitFor(() => expect(screen.getByTestId('running-pane').dataset.pane).toBe('graph'));
    expect(screen.queryByTestId('running-activity')).toBeNull();
  });

  it('lets the slot open the session\'s chat, which leaves the pane for the route\'s own view', async () => {
    await mount((context) => <button type="button" data-testid="open-chat" onClick={context.openChat}>open</button>);
    fireEvent.click(graphNode('agent:s1:tu-1')!);
    fireEvent.click(await screen.findByTestId('open-chat'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/session/s1'));
    await screen.findByTestId('route-view');
  });
});
