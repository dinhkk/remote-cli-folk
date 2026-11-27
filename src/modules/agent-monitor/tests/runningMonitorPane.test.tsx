import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { RunningMonitorPane, useRunningMainPane } from '@/modules/agent-monitor';
import { findGraph, findGraphNode, graphEdge, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { MACHINE, installFakeMonitorApi, makeNode, makeRow, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch, Where } from '@/modules/agent-monitor/tests/runningHarness';
import type { AgentMonitorSnapshot } from '@/shared/types';

/**
 * The main pane of the Running tab, showing the OVERVIEW: the KPI strip, the live graph of every session, usage and
 * resources (numbers and state labels, no explanatory prose); the UI states that limit what it claims; motion and reduced
 * motion; one poll. The graph is a lazy chunk: tests warm it once and wait for it. (The graph's own behaviour, dragging
 * included, is in monitorGraph.test.tsx; focus behaviour is in the sidebar's runningTabTree.test.tsx.)
 */

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

/** What the workspace does: the pane while the Running tab asks for one, else the route's own view. */
function Main() {
  const pane = useRunningMainPane();
  return pane ? <RunningMonitorPane leading={<span data-testid="pane-leading" />} /> : <div data-testid="route-view" />;
}

const WORKING: AgentMonitorSnapshot = makeSnapshot({
  sessions: [
    makeSession({
      id: 's1',
      label: 'Review Alpha',
      agentTokens: 1500,
      orchestrator: { name: 'orchestrator', fromProfile: true, state: 'running', lastToolName: 'Read', contextTokens: 42_000, contextWindow: 200_000 },
      agents: [
        makeNode({ id: 'tu-1', name: 'review-code--alpha', description: 'Review MR 123', startedAt: 1_000_000, tokens: 1200, toolCalls: 3, lastToolName: 'Grep', tokensPerSecond: 50 }),
        makeNode({ id: 'tu-2', name: 'ba--alpha', state: 'waiting', startedAt: 1_002_000, tokens: 300, toolCalls: 1, lastToolName: 'Write' }),
        makeNode({ id: 'tu-3', name: 'testing--alpha', state: 'done', startedAt: 990_000, endedAt: 1_000_000, tokens: 400, toolCalls: 2 }),
      ],
    }),
  ],
  resources: {
    sampling: true, intervalMs: 2000, lastSampleAt: 1_004_000, error: null, cores: 8, machine: MACHINE,
    rows: [
      makeRow({ key: 'server', kind: 'server', label: 'Server', pid: 10, usage: { cpuPercent: 0.04, rssBytes: 120 * 1024 * 1024, processCount: 1, top: [] } }),
      makeRow({ key: 'session:s1', label: 'Review Alpha', pid: 100, usage: { cpuPercent: 62.5, rssBytes: 3 * 1024 ** 3, processCount: 4, top: [{ pid: 100, name: 'claude', rssBytes: 260 * 1024 * 1024, cpuPercent: 1 }, { pid: 101, name: 'node', rssBytes: 2.7 * 1024 ** 3, cpuPercent: 61 }] } }),
    ],
  },
});

/** Mounts the pane and, when the snapshot has a session, waits for the lazy graph to be drawn. */
const mount = async (snapshot: AgentMonitorSnapshot = WORKING) => {
  installFakeMonitorApi(() => snapshot);
  renderRunning(<><RunningTabSwitch /><Main /><Where /></>);
  await screen.findByTestId('agent-monitor');
  if (snapshot.sessions.length > 0) await findGraph();
};

const node = (id: string) => graphNode(id) as HTMLElement;

describe('the overview pane', () => {
  it('shows the tree of one session, rooted at the session: main agent and each agent with its state, no server box', async () => {
    stubReducedMotion(true);
    await mount();

    expect(screen.getByTestId('running-pane').dataset.pane).toBe('overview');
    expect(node('server')).toBeNull();
    expect(node('session:s1').dataset.nodeKind).toBe('session');
    expect(node('session:s1').textContent).toContain('Review Alpha');
    expect(node('orch:s1').textContent).toContain('orchestrator');
    expect(node('orch:s1').textContent).toContain('▸ Read');
    expect(node('agent:s1:tu-1').dataset.nodeState).toBe('running');
    expect(node('agent:s1:tu-2').dataset.nodeState).toBe('waiting');
    expect(node('agent:s1:tu-3').dataset.nodeState).toBe('done');
    expect(node('agent:s1:tu-1').textContent).toContain('review-code--alpha');
    expect(node('agent:s1:tu-1').textContent).toContain('1.2k');
    expect(node('agent:s1:tu-1').getAttribute('title')).toContain('Tool calls 3');
    expect(node('agent:s1:tu-1').textContent).toContain('▸ Grep');
    expect(node('agent:s1:tu-3').textContent).toContain('testing--alpha');
    // The state also reads in words for a screen reader.
    expect(screen.getByRole('button', { name: 'Agent ba--alpha (Waiting for permission): focus it' })).toBeTruthy();
    expect(screen.getByTestId('running-pane-summary').textContent).toBe('1 running · 2 agents');
  });

  it('is a tidy column: summary, KPI strip (machine card included), graph card; and no explanatory notes, legend or how-to text', async () => {
    stubReducedMotion(true);
    await mount(makeSnapshot({ ...WORKING, sessions: [...WORKING.sessions, makeSession({ id: 't1', source: 'terminal', detail: 'transcript', openSessionId: null })] }));

    const order = ['running-pane-summary', 'monitor-kpi-strip', 'monitor-graph-card'].map((id) => screen.getByTestId(id));
    order.slice(1).forEach((element, index) => expect(order[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    for (const gone of [/Click a box/i, /Colours/i, /may lag/i, /never per agent/i, /No cost is shown/i, /billed totals/i, /prices behind/i, /logical cores/i]) {
      expect(screen.queryByText(gone), String(gone)).toBeNull();
    }
    expect(screen.queryByTestId('monitor-limits-note')).toBeNull();
    expect(screen.queryByTestId('monitor-derived-note')).toBeNull();
  });

  it('gives a phone the workspace\'s menu button in the pane header (the way back to the list)', async () => {
    stubReducedMotion(true);
    await mount();
    expect(screen.getByTestId('pane-leading')).toBeTruthy();
  });

  it('shows the KPI strip with the numbers of the snapshot', async () => {
    stubReducedMotion(true);
    await mount();
    expect(screen.getByTestId('kpi-agents-value').textContent).toBe('2');
    expect(screen.getByTestId('kpi-token-rate-value').textContent).toBe('1.5k');
    expect(screen.getByTestId('kpi-tokens-today-value').textContent).toBe('24k');
    // CPU and memory are not headline counts: the server's are on its own card.
    expect(screen.queryByTestId('kpi-cpu')).toBeNull();
    expect(screen.queryByTestId('kpi-memory')).toBeNull();
    expect(within(screen.getByTestId('kpi-token-rate')).getByRole('img').getAttribute('aria-label')).toContain('last 60 seconds');
  });

  it('shows a dash for the machine CPU until the server has two readings, and the memory already', async () => {
    stubReducedMotion(true);
    await mount(makeSnapshot({ resources: { ...WORKING.resources, machine: { ...MACHINE, cpuPercent: null } } }));
    expect(screen.getByTestId('machine-cpu').textContent).toBe('—');
    expect(screen.getByTestId('machine-memory').textContent).toBe('10.0 GB / 16.0 GB');
  });

  it('counts the running timers up each second from the server clock', async () => {
    stubReducedMotion(true);
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_005_000);
    installFakeMonitorApi(() => WORKING);
    renderRunning(<><RunningTabSwitch /><Main /></>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await screen.findByTestId('agent-monitor');
    await findGraph();

    // generatedAt is 1_005_000 and the agent started at 1_000_000: 5 s.
    expect(node('agent:s1:tu-1').getAttribute('title')).toContain('Elapsed 0:05 — Tokens 1.2k');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(node('agent:s1:tu-1').getAttribute('title')).toContain('Elapsed 0:08 — Tokens 1.2k');
    // A finished agent's clock stopped when it ended: 10 s.
    expect(node('agent:s1:tu-3').getAttribute('title')).toContain('Elapsed 0:10 — Tokens 400');
  });

  it('shows the machine alone while nothing is selected: no session, agent or token numbers of any session', async () => {
    stubReducedMotion(true);
    await mount();
    expect(screen.getByTestId('machine-card')).toBeTruthy();
    expect(within(screen.getByTestId('machine-card')).getByTestId('machine-cpu').textContent).toBe('38%');
    expect(within(screen.getByTestId('machine-card')).getByTestId('machine-memory').textContent).toBe('10.0 GB / 16.0 GB');
    for (const gone of ['resource-rows', 'resource-row-session', 'tokens-by-agent', 'tokens-by-project', 'tokens-by-model', 'cache-hit-list', 'selection-detail']) {
      expect(screen.queryByTestId(gone), gone).toBeNull();
    }
  });
  it('says so in one short line when nothing is running, draws no graph (React Flow is not even loaded), and still shows the machine resources', async () => {
    stubReducedMotion(true);
    await mount(makeSnapshot({ resources: { ...WORKING.resources, rows: [makeRow({ key: 'server', kind: 'server', label: 'Server' })] } }));
    expect(screen.getByTestId('monitor-empty').textContent).toBe('Nothing is running.');
    expect(screen.queryByTestId('monitor-graph')).toBeNull();
    expect(screen.queryByTestId('monitor-graph-loading')).toBeNull();
    expect(screen.getByTestId('machine-card')).toBeTruthy();
  });

  it('draws the child processes of a session as grey buttons with name, count, memory and CPU', async () => {
    stubReducedMotion(true);
    await mount(makeSnapshot({
      sessions: [makeSession({
        id: 's1',
        agents: [makeNode({ id: 'a1' })],
        processes: [
          { name: 'node', count: 3, rssBytes: 200 * 1024 * 1024, cpuPercent: 12.4 },
          { name: 'bash', count: 1, rssBytes: 5 * 1024 * 1024, cpuPercent: null },
          { name: '', count: 2, rssBytes: 1024 * 1024, cpuPercent: 0 },
        ],
      })],
    }));

    const nodeLeaf = node('proc:s1:node');
    expect(nodeLeaf.dataset.nodeKind).toBe('process');
    expect(nodeLeaf.dataset.nodeState).toBe('running');
    expect(nodeLeaf.textContent).toContain('node');
    expect(nodeLeaf.getAttribute('title')).toContain('Processes 3');
    expect(nodeLeaf.textContent).toContain('200 MB');
    expect(nodeLeaf.textContent).toContain('12%');
    expect(nodeLeaf.getAttribute('aria-label')).toBe('Child processes node: 3 running, 200 MB of memory');
    expect(nodeLeaf.getAttribute('role')).toBe('button');
    expect(nodeLeaf.getAttribute('aria-pressed')).toBe('false');
    expect(nodeLeaf.getAttribute('tabindex')).toBe('0');
    expect(node('proc:s1:bash').textContent).not.toContain('%');
    expect(node('proc:s1:*other').textContent).toContain('other processes');
    const outline = nodeLeaf.querySelector('div');
    expect(outline?.className).toContain('border-slate-400');
    expect(outline?.className).toContain('border-dashed');
    expect(nodeLeaf.querySelector('[data-state-glyph]')).toBeNull();
    await waitFor(() => expect(graphEdge('orch:s1>proc:s1:node')).not.toBeNull());
    expect(graphEdge('orch:s1>proc:s1:node')?.getAttribute('data-edge-flowing')).toBe('true');
    expect(graphEdge('orch:s1>proc:s1:bash')?.getAttribute('data-edge-flowing')).toBe('false');
  });

  it('notes the process groups that are not drawn', async () => {
    stubReducedMotion(true);
    const processes = Array.from({ length: 8 }, (_, index) => ({ name: `tool${index}`, count: 1, rssBytes: 1024, cpuPercent: 0 }));
    await mount(makeSnapshot({ sessions: [makeSession({ id: 's1', processes })] }));
    expect(screen.getByTestId('monitor-graph-omitted-processes').textContent).toContain('3 more process groups');
  });

  it('flows a process edge only with motion on and CPU above the threshold', async () => {
    stubReducedMotion(false);
    await mount(makeSnapshot({ sessions: [makeSession({ id: 's1', processes: [{ name: 'node', count: 1, rssBytes: 1024, cpuPercent: 30 }, { name: 'bash', count: 1, rssBytes: 1024, cpuPercent: 0.2 }] })] }));
    await waitFor(() => expect(graphEdge('orch:s1>proc:s1:node')).not.toBeNull());
    expect(graphEdge('orch:s1>proc:s1:node')?.getAttribute('class')).toContain('monitor-edge-flow');
    expect(graphEdge('orch:s1>proc:s1:bash')?.getAttribute('class')).not.toContain('monitor-edge-flow');
  });

  it('plays motion by default: spinner on a working agent, pulse, flowing edges, and a blink while waiting', async () => {
    stubReducedMotion(false);
    await mount();
    const root = screen.getByTestId('agent-monitor');
    expect(root.dataset.motion).toBe('on');
    expect(root.className).toContain('monitor-anim');
    expect(node('agent:s1:tu-1').querySelector('.monitor-spin')).not.toBeNull();
    expect(node('agent:s1:tu-1').querySelector('.monitor-pulse')).not.toBeNull();
    expect(node('agent:s1:tu-2').querySelector('.monitor-blink')).not.toBeNull();
    expect(node('agent:s1:tu-3').querySelector('.monitor-done')).not.toBeNull();
    await waitFor(() => expect(graphEdge('orch:s1>agent:s1:tu-1')).not.toBeNull());
    expect(graphEdge('orch:s1>agent:s1:tu-1')?.getAttribute('class')).toContain('monitor-edge-flow');
    expect(graphEdge('orch:s1>agent:s1:tu-3')?.getAttribute('class')).not.toContain('monitor-edge-flow');
    expect((node('agent:s1:tu-1').closest('.react-flow__node') as HTMLElement).style.transform).toContain('translate(');
  });

  it('with reduced motion nothing animates and the states differ by colour and glyph only', async () => {
    stubReducedMotion(true);
    await mount();
    const root = screen.getByTestId('agent-monitor');
    expect(root.dataset.motion).toBe('off');
    expect(root.className).not.toContain('monitor-anim');
    await waitFor(() => expect(graphEdge('orch:s1>agent:s1:tu-1')).not.toBeNull());
    for (const animated of ['.monitor-spin', '.monitor-pulse', '.monitor-blink', '.monitor-edge-flow', '.monitor-enter', '.monitor-done', '.monitor-shake']) {
      expect(document.querySelector(animated), animated).toBeNull();
    }
    expect(node('agent:s1:tu-1').querySelector('div')?.className).toContain('border-blue-500');
    expect(node('agent:s1:tu-2').querySelector('div')?.className).toContain('border-amber-500');
    expect(node('agent:s1:tu-3').querySelector('div')?.className).toContain('border-emerald-500');
    expect(node('agent:s1:tu-1').querySelector('[data-state-glyph="running"]')).not.toBeNull();
    expect(node('agent:s1:tu-2').querySelector('[data-state-glyph="waiting"]')).not.toBeNull();
    expect(node('agent:s1:tu-3').querySelector('[data-state-glyph="done"]')).not.toBeNull();
    expect(screen.getByTestId('kpi-agents-value').textContent).toBe('2');
  });

  it('draws a new agent on the next poll and updates a finished one, without a one-shot packet or a refit of the view', async () => {
    stubReducedMotion(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = makeSnapshot({ sessions: [makeSession({ id: 's1', agents: [makeNode({ id: 'a1' })] })] });
    installFakeMonitorApi(() => current);
    renderRunning(<><RunningTabSwitch /><Main /></>);
    await screen.findByTestId('agent-monitor');
    await findGraph();
    const flow = document.querySelector('.react-flow');

    current = makeSnapshot({ sessions: [makeSession({ id: 's1', agents: [makeNode({ id: 'a1' }), makeNode({ id: 'a2' })] })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await findGraphNode('agent:s1:a2');
    await waitFor(() => expect(graphEdge('orch:s1>agent:s1:a2')).not.toBeNull());

    current = makeSnapshot({ sessions: [makeSession({ id: 's1', agents: [makeNode({ id: 'a1', state: 'done', endedAt: 1_004_000 }), makeNode({ id: 'a2' })] })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(node('agent:s1:a1').dataset.nodeState).toBe('done'));
    // The same flow all along: a poll never resets the user's pan, zoom or dragged boxes.
    expect(document.querySelector('.react-flow')).toBe(flow);
  });
});

describe('the pane\'s states and its one poll', () => {
  it('shows the error with a retry button when the first load fails, then recovers', async () => {
    stubReducedMotion(true);
    let fail = true;
    const api = installFakeMonitorApi(() => (fail ? { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Not allowed here' } } } : WORKING));
    renderRunning(<><RunningTabSwitch /><Main /></>);
    const alert = await screen.findByTestId('monitor-error');
    expect(alert.textContent).toContain('Not allowed here');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('agent-monitor');
    expect(api.paths.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the last picture and says it is stale when a later poll fails', async () => {
    stubReducedMotion(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    installFakeMonitorApi(() => (fail ? { status: 500, body: { success: false, error: { message: 'boom' } } } : WORKING));
    renderRunning(<><RunningTabSwitch /><Main /></>);
    await screen.findByTestId('agent-monitor');
    await findGraph();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    const banner = await screen.findByTestId('monitor-stale');
    expect(banner.textContent).toContain('Showing the last picture');
    expect(node('agent:s1:tu-1')).toBeTruthy();
  });

  it('polls about once a second while visible and stops while the tab is hidden', async () => {
    stubReducedMotion(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = installFakeMonitorApi(() => WORKING);
    renderRunning(<><RunningTabSwitch /><Main /></>);
    await screen.findByTestId('agent-monitor');
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    const whileVisible = api.paths.length;
    expect(whileVisible).toBeGreaterThanOrEqual(3);
    expect(api.paths.every((path) => path === '/api/agent-monitor/snapshot')).toBe(true);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    const atHide = api.paths.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.paths.length).toBe(atHide);
    expect(screen.getByTestId('agent-monitor').dataset.paused).toBe('true');

    Reflect.deleteProperty(document, 'visibilityState');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(api.paths.length).toBeGreaterThan(atHide);
  });

  it('never polls while the Running tab is not on show, and shows the route\'s own view', async () => {
    stubReducedMotion(true);
    installFakeMonitorApi(() => WORKING);
    renderRunning(<><RunningTabSwitch initiallyOn={false} /><Main /></>);
    expect(screen.getByTestId('route-view')).toBeTruthy();
    expect(screen.queryByTestId('running-pane')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turning the Running tab on while a chat is open leaves the chat for the overview at once, with nothing clicked', async () => {
    stubReducedMotion(true);
    installFakeMonitorApi(() => WORKING);
    renderRunning(<><RunningTabSwitch initiallyOn={false} /><Main /><Where /></>, '/session/abc');
    expect(screen.getByTestId('where').textContent).toBe('/session/abc');
    expect(screen.getByTestId('route-view')).toBeTruthy();

    fireEvent.click(screen.getByTestId('tab-switch'));

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    expect((await screen.findByTestId('running-pane')).dataset.pane).toBe('overview');
  });

  it('is on its loading text and asks for nothing while the page is hidden from the start', async () => {
    stubReducedMotion(false);
    installFakeMonitorApi(() => WORKING);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    renderRunning(<><RunningTabSwitch /><Main /></>);
    expect(await screen.findByTestId('monitor-loading')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
