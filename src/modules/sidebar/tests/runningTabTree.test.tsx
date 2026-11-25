import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useMemo, type ComponentProps } from 'react';
import { useParams } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { RunningMonitorPane, useRunningMainPane, useRunningSessionClick } from '@/modules/agent-monitor';
// The monitor's test doubles (snapshot builders, fake API, router/provider harness) are shared on purpose: this suite is the one
// that mounts the monitor's tree inside the real sidebar, and rebuilding them here would let the two drift.
// oxlint-disable-next-line boundaries/dependencies
import { installFakeMonitorApi, makeNode, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
// oxlint-disable-next-line boundaries/dependencies
import { findGraphNode, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
// oxlint-disable-next-line boundaries/dependencies
import { renderRunning, RunningTabSwitch, Where } from '@/modules/agent-monitor/tests/runningHarness';
import type { AgentMonitorSession, AgentMonitorSnapshot, Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * The Running tab as a whole: the REAL sidebar content (project list, project rows, session rows) with the monitor's tree
 * under each running session, the terminal sessions merged in, and the main pane beside it, all behind the real focus
 * provider. Header, footer and the row's options menu are stubbed (they need the app's other providers).
 */

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => <header data-testid="sidebar-header" /> }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => <span data-testid="session-options" /> }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));

const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');
const { getAllSessions } = await import('@/modules/sidebar/utils/sidebarProjectFormatting');

const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => undefined;
const NO_IDS: ReadonlySet<string> = new Set<string>();

const project = (projectId: string, fullPath: string, sessionIds: string[]): Project => ({
  projectId,
  displayName: projectId.toUpperCase(),
  fullPath,
  sessions: sessionIds.map((id) => ({ id, summary: `Session ${id}`, lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude' })),
}) as unknown as Project;

const ALPHA = project('alpha', 'C:\\work\\Alpha', ['s1', 's2']);
const OTHER = project('other', 'C:\\work\\Other', []);
const ALL_PROJECTS = [ALPHA, OTHER];

const s1 = makeSession({
  id: 's1', label: 'Review Alpha', agentTokens: 1500,
  orchestrator: { name: 'orchestrator', fromProfile: true, state: 'running', lastToolName: 'Read', contextTokens: null, contextWindow: null },
  agents: [
    makeNode({ id: 'tu-1', name: 'review-code--alpha', tokens: 1200, lastToolName: 'Grep' }),
    makeNode({ id: 'tu-2', name: 'ba--alpha', state: 'waiting', tokens: 300 }),
  ],
  processes: [{ name: 'node', count: 3, rssBytes: 200 * 1024 * 1024, cpuPercent: 12.4 }, { name: '', count: 2, rssBytes: 1024 * 1024, cpuPercent: 0 }],
});
const s2 = makeSession({
  id: 's2', label: 'Fix login', state: 'idle',
  orchestrator: { name: 'main', fromProfile: false, state: 'done', lastToolName: null, contextTokens: null, contextWindow: null },
  agents: [makeNode({ id: 'old', name: 'old-agent', state: 'done', endedAt: 1_001_000 })],
});
const terminal = (id: string, extra: Partial<AgentMonitorSession> = {}) => makeSession({
  id, source: 'terminal', detail: 'transcript', openSessionId: null, label: id, projectName: null, projectPath: 'C:\\work\\Alpha', ...extra,
});

const snapshotOf = (sessions: AgentMonitorSession[]): AgentMonitorSnapshot => makeSnapshot({ sessions });

type SidebarStandInProps = { displayed: Project[]; search?: string };

/** What Sidebar hands SidebarContent in the Running tab: the usual list props, with the toggling session click. */
function SidebarStandIn({ displayed, search = '' }: SidebarStandInProps) {
  const select = useRunningSessionClick<SessionWithProvider, string>();
  const listProps = useMemo<SidebarProjectListProps>(() => ({
    projects: ALL_PROJECTS,
    filteredProjects: displayed,
    selectedProject: null,
    selectedSession: null,
    isLoading: false,
    loadingProgress: null,
    isProjectExpanded: () => true,
    activeRename: null,
    initialSessionsLoaded: new Set(['alpha', 'other']),
    currentTime: NOW,
    deletingProjects: new Set(),
    tasksEnabled: false,
    mcpServerStatus: null,
    getProjectSessions: getAllSessions,
    onLoadMoreSessions: noop,
    loadingMoreProjects: new Set(),
    activeSessions: NO_IDS,
    backgroundSessionIds: NO_IDS,
    attentionSessionIds: NO_IDS,
    isProjectStarred: () => false,
    onRenameDraftChange: noop,
    onToggleProject: noop,
    onProjectSelect: noop,
    onToggleStarProject: noop,
    onStartEditingProject: noop,
    onCancelEditingProject: noop,
    onSaveProjectName: noop,
    onDeleteProject: noop,
    onSessionSelect: select,
    onDeleteSession: noop,
    onNewSession: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    sessionSelection: null,
    onSetSessionSelection: noop,
    onToggleSessionSelected: noop,
    onCancelSessionSelection: noop,
    onDeleteSelectedSessions: noop,
    t: ((key: string, fallback?: string) => fallback ?? key) as unknown as SidebarProjectListProps['t'],
  }), [displayed, select]);

  const props = {
    isPWA: false, isMobile: false, isLoading: false, projects: ALL_PROJECTS, runningSessionsCount: displayed.length > 0 ? 1 : 0,
    archivedProjects: [], archivedSessions: [], archivedSessionsCount: 0, isArchivedSessionsLoading: false,
    recentConversations: [], recentConversationsTotal: 0, recentConversationsHasMore: false, isRecentConversationsLoading: false,
    isLoadingMoreRecentConversations: false, recentConversationsError: false,
    searchFilter: search, onSearchFilterChange: noop, onClearSearchFilter: noop, searchMode: 'running' as const, onSearchModeChange: noop,
    conversationResults: null, isSearching: false, searchProgress: null,
    onRestoreArchivedProject: noop, onLoadMoreRecentConversations: noop, onRetryRecentConversations: noop, onArchivedSessionClick: noop,
    onRestoreArchivedSession: noop, onDeleteArchivedSession: noop, onConversationResultClick: noop, onRefresh: noop, isRefreshing: false,
    onCreateProject: noop, onCollapseSidebar: noop, updateAvailable: false, restartRequired: false, releaseInfo: null, latestVersion: null,
    currentVersion: '1.0.0', onShowVersionModal: noop, onShowSettings: noop,
    projectListProps: listProps,
    t: listProps.t,
  } as unknown as ComponentProps<typeof SidebarContent>;
  return <SidebarContent {...props} />;
}

/** What the workspace does with the main area: the pane while the Running tab asks for one, else the route's own view. */
function Main() {
  const pane = useRunningMainPane();
  const { sessionId } = useParams<{ sessionId?: string }>();
  return pane ? <RunningMonitorPane /> : <div data-testid="route-view">{sessionId ? `chat ${sessionId}` : 'start page'}</div>;
}

let current: AgentMonitorSnapshot;

const mount = async (snapshot: AgentMonitorSnapshot, options: { displayed?: Project[]; path?: string; tab?: boolean; hooks?: { onFocusChosen?: () => void } } = {}) => {
  current = snapshot;
  const api = installFakeMonitorApi(() => current);
  const displayed = options.displayed ?? [ALPHA];
  renderRunning(
    <>
      <RunningTabSwitch initiallyOn={options.tab ?? true} />
      <div data-testid="sidebar-area"><SidebarStandIn displayed={displayed} /></div>
      <Main />
      <Where />
    </>,
    options.path ?? '/',
    options.hooks,
  );
  if (options.tab ?? true) await waitFor(() => expect(api.paths.length).toBeGreaterThan(0));
  return api;
};

const pane = () => screen.getByTestId('running-pane');
/** The sidebar only: the graph's boxes carry the same accessible names as the rows, so row lookups must not see them. */
const tree = () => within(screen.getByTestId('sidebar-area'));
const where = () => screen.getByTestId('where').textContent;
const tick =async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

// The graph is a lazy chunk (React Flow): load it once up front so the tests that look at its boxes wait for a tick, not a transform.
beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);
beforeEach(() => { stubReducedMotion(true); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('the tree under the Project and Session rows', () => {
  it('extends the usual list: project, session row with its own actions, main agent, then sub-agents and processes as siblings', async () => {
    await mount(snapshotOf([s1, s2]));
    const session = await screen.findByTestId('running-session-s1');

    // The existing rows are still the ones drawn: the project name, the session link and its options menu.
    expect(tree().getByTitle('ALPHA')).toBeTruthy();
    expect(within(session).getByRole('link', { name: /Session s1/ }).getAttribute('href')).toBe('/session/s1');
    expect(within(session).getByTestId('session-options')).toBeTruthy();

    const main = within(session).getByTestId('running-main-s1');
    expect(within(main).getByRole('button', { name: 'Main agent orchestrator of Review Alpha: show it in the graph' }).textContent).toContain('▸ Read');

    // Siblings: the agents and the process groups share one list under the main agent.
    const children = within(session).getByTestId('running-children-s1');
    const labels = within(children).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Agent review-code--alpha (Working): show it in the graph',
      'Agent ba--alpha (Waiting for permission): show it in the graph',
      'Processes node, 3 running, 200 MB of memory: show them in the graph',
      'Processes other processes, 2 running, 1.0 MB of memory: show them in the graph',
    ]);
    expect(within(children).getByTestId('running-agent-s1-tu-1').textContent).toContain('▸ Grep · 1.2k tok');
    expect(within(children).getByTestId('running-agent-s1-tu-2').dataset.state).toBe('waiting');
    // A process row shows name, count and memory only.
    expect(within(children).getByTestId('running-process-s1-node').textContent).toBe('node ×3200 MB');
  });

  it('opens a working session to its main agent, and leaves a settled one closed until it is opened', async () => {
    await mount(snapshotOf([s1, s2]));
    const settled = await screen.findByTestId('running-session-s2');
    expect(within(settled).queryByTestId('running-main-s2')).toBeNull();
    const toggle = within(settled).getByRole('button', { name: 'Expand Fix login' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    const main = within(settled).getByTestId('running-main-s2');
    // Nothing is working under it, so the main agent stays closed too, but it is expandable on demand.
    expect(within(settled).queryByTestId('running-children-s2')).toBeNull();
    fireEvent.click(within(main).getByRole('button', { name: 'Expand main' }));
    expect(within(settled).getByTestId('running-agent-s2-old')).toBeTruthy();
  });

  it('opens and closes each node on its own, with aria-expanded telling which', async () => {
    await mount(snapshotOf([s1]));
    const session = await screen.findByTestId('running-session-s1');
    const mainToggle = within(within(session).getByTestId('running-main-s1')).getByRole('button', { name: 'Collapse orchestrator' });
    expect(mainToggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(mainToggle);
    expect(within(session).queryByTestId('running-children-s1')).toBeNull();
    expect(within(session).getByRole('button', { name: 'Expand orchestrator' }).getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(within(session).getByRole('button', { name: 'Collapse Review Alpha' }));
    expect(within(session).queryByTestId('running-main-s1')).toBeNull();
  });

  it('keeps every row a button of at least 44 px on a phone (the dense height only from the md breakpoint)', async () => {
    await mount(snapshotOf([s1]));
    const session = await screen.findByTestId('running-session-s1');
    const buttons = [
      within(session).getByRole('button', { name: /Main agent orchestrator/ }),
      within(session).getByRole('button', { name: /Agent review-code--alpha/ }),
      within(session).getByRole('button', { name: /Processes node/ }),
    ];
    for (const button of buttons) expect(button.className).toContain('min-h-[44px]');
    expect(within(session).getByRole('button', { name: 'Collapse Review Alpha' }).className).toContain('h-11 w-11');
  });
});

describe('focus: main agent, sub-agent and process rows', () => {
  it.each([
    ['the main agent', /Main agent orchestrator/, 'orch:s1'],
    ['a sub-agent', /Agent review-code--alpha/, 'agent:s1:tu-1'],
    ['a process group', /Processes node/, 'proc:s1:node'],
  ])('focuses %s on a click, shows the graph of that session with it ringed, and releases it on a second click', async (_name, label, nodeId) => {
    await mount(snapshotOf([s1, s2]));
    const row = await tree().findByRole('button', { name: label });
    expect(pane().dataset.pane).toBe('overview');
    expect(row.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(row);
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));
    expect(tree().getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('running-pane-title').textContent).toBe('Graph: Review Alpha');
    // The single-session graph: only this session's tree, the focused box ringed and pressed.
    await findGraphNode(nodeId);
    expect(document.querySelectorAll('[data-node-kind="session"]')).toHaveLength(1);
    expect(graphNode(nodeId)?.getAttribute('aria-pressed')).toBe('true');
    expect(graphNode(nodeId)?.querySelector('[data-focus-ring]')).not.toBeNull();
    expect(document.querySelectorAll('[data-focus-ring]')).toHaveLength(1);
    expect(where()).toBe('/');

    fireEvent.click(tree().getByRole('button', { name: label }));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
    expect(tree().getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false');
  });

  it('moves the focus from one row to another instead of keeping two', async () => {
    await mount(snapshotOf([s1]));
    fireEvent.click(await tree().findByRole('button', { name: /Agent review-code--alpha/ }));
    fireEvent.click(tree().getByRole('button', { name: /Processes node/ }));
    expect(tree().getByRole('button', { name: /Agent review-code--alpha/ }).getAttribute('aria-pressed')).toBe('false');
    expect(tree().getByRole('button', { name: /Processes node/ }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.querySelectorAll('[data-focus-ring]')).toHaveLength(1));
    expect(graphNode('proc:s1:node')?.querySelector('[data-focus-ring]')).not.toBeNull();
  });

  it('closes a phone\'s sidebar drawer on every focus change (the hook the workspace route binds)', async () => {
    const onFocusChosen = vi.fn();
    await mount(snapshotOf([s1]), { hooks: { onFocusChosen } });
    fireEvent.click(await tree().findByRole('button', { name: /Agent review-code--alpha/ }));
    expect(onFocusChosen).toHaveBeenCalledTimes(1);
    fireEvent.click(tree().getByRole('button', { name: /Agent review-code--alpha/ }));
    expect(onFocusChosen).toHaveBeenCalledTimes(2);
  });

  it('forgets a focus on a session that has left the picture, and the pane returns to the overview', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount(snapshotOf([s1]));
    fireEvent.click(await tree().findByRole('button', { name: /Main agent orchestrator/ }));
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));

    current = snapshotOf([]);
    await tick(1100);
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
  });
});

describe('focus: the session row', () => {
  it('only focuses the session on a click (its graph shows, the route stays) and lets go on a second click; it never opens the chat', async () => {
    await mount(snapshotOf([s1]));
    const link = await screen.findByRole('link', { name: /Session s1/ });
    expect(pane().dataset.pane).toBe('overview');

    fireEvent.click(link);
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));
    expect(where()).toBe('/');
    expect(screen.getByTestId('running-pane-title').textContent).toBe('Graph: Review Alpha');
    await findGraphNode('session:s1');
    expect(graphNode('session:s1')?.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('link', { name: /Session s1/ }));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
    expect(where()).toBe('/');
  });

  it('with a chat open when the Running tab is switched on, the chat is left at once for the overview, with no row clicked', async () => {
    await mount(snapshotOf([s1]), { path: '/session/s1', tab: false });
    // Tab off: the chat is what the route says, no pane covers it.
    expect(screen.getByTestId('route-view').textContent).toBe('chat s1');

    fireEvent.click(screen.getByTestId('tab-switch'));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
    expect(where()).toBe('/');
  });

  it('moves a node focus to the session when its row is clicked', async () => {
    await mount(snapshotOf([s1]));
    fireEvent.click(await tree().findByRole('button', { name: /Agent review-code--alpha/ }));
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));

    fireEvent.click(screen.getByRole('link', { name: /Session s1/ }));
    await findGraphNode('session:s1');
    await waitFor(() => expect(graphNode('session:s1')?.getAttribute('aria-pressed')).toBe('true'));
    expect(tree().getByRole('button', { name: /Agent review-code--alpha/ }).getAttribute('aria-pressed')).toBe('false');
    expect(where()).toBe('/');
  });

});

describe('leaving and entering the Running tab', () => {
  it('shows the overview with nothing focused, and the route\'s own view once the tab is left', async () => {
    await mount(snapshotOf([s1]));
    await screen.findByTestId('running-session-s1');
    expect(pane().dataset.pane).toBe('overview');
    expect(within(pane()).getByTestId('kpi-agents-value')).toBeTruthy();

    fireEvent.click(screen.getByTestId('tab-switch'));
    expect(screen.queryByTestId('running-pane')).toBeNull();
    expect(screen.getByTestId('route-view').textContent).toBe('start page');
  });

  it('clears a graph focus when the tab is left: coming back shows the overview', async () => {
    await mount(snapshotOf([s1]));
    fireEvent.click(await tree().findByRole('button', { name: /Agent review-code--alpha/ }));
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));

    fireEvent.click(screen.getByTestId('tab-switch'));
    expect(screen.queryByTestId('running-pane')).toBeNull();
    fireEvent.click(screen.getByTestId('tab-switch'));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
  });

  it('polls once for the whole tab, tree and pane together, and not at all while the tab is not on show', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = await mount(snapshotOf([s1]));
    await screen.findByTestId('running-session-s1');
    await tick(3100);
    // About one request a second (the first at once): a second poller for the tree would double it.
    expect(api.paths.length).toBeGreaterThanOrEqual(3);
    expect(api.paths.length).toBeLessThanOrEqual(5);
    expect(new Set(api.paths)).toEqual(new Set(['/api/agent-monitor/snapshot']));

    fireEvent.click(screen.getByTestId('tab-switch'));
    const atLeave = api.paths.length;
    await tick(5000);
    expect(api.paths.length).toBe(atLeave);
  });
});

describe('the graph clicks back into the tree', () => {
  it('focuses an agent, a process or a session box in the list; no box opens the chat', async () => {
    await mount(snapshotOf([s1]));
    await screen.findByTestId('running-session-s1');

    fireEvent.click(await findGraphNode('agent:s1:tu-2'));
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));
    expect(tree().getByRole('button', { name: /Agent ba--alpha/ }).getAttribute('aria-pressed')).toBe('true');

    // Click the focused box again: released.
    fireEvent.click(await findGraphNode('agent:s1:tu-2'));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));

    fireEvent.keyDown(await findGraphNode('proc:s1:node'), { key: 'Enter' });
    await waitFor(() => expect(tree().getByRole('button', { name: /Processes node/ }).getAttribute('aria-pressed')).toBe('true'));

    fireEvent.click(await findGraphNode('session:s1'));
    await waitFor(() => expect(graphNode('session:s1')?.getAttribute('aria-pressed')).toBe('true'));
    expect(where()).toBe('/');
    expect(pane().dataset.pane).toBe('graph');

    fireEvent.click(await findGraphNode('session:s1'));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
  });

  it('opens a closed session and main agent in the list so the focused row is visible', async () => {
    await mount(snapshotOf([s1]));
    const session = await screen.findByTestId('running-session-s1');
    fireEvent.click(within(session).getByRole('button', { name: 'Collapse Review Alpha' }));
    expect(within(session).queryByTestId('running-main-s1')).toBeNull();

    fireEvent.click(await findGraphNode('agent:s1:tu-1'));
    await waitFor(() => expect(within(session).getByRole('button', { name: /Agent review-code--alpha/ }).getAttribute('aria-pressed')).toBe('true'));
  });
});

describe('terminal sessions', () => {
  const T1 = terminal('term-1', { agents: [makeNode({ id: 'a', name: 'coding--x', lastToolName: 'Bash', tokens: 600 })] });

  it('joins the project row of the same folder, with a small terminal badge', async () => {
    await mount(snapshotOf([s1, T1]));
    const row = await screen.findByTestId('running-terminal-session-term-1');
    // In the ALPHA project row, after its app sessions.
    expect(within(screen.getByTestId('running-terminals-alpha')).getByTestId('running-terminal-session-term-1')).toBe(row);
    expect(within(row).getByTestId('running-terminal-badge').textContent).toBe('terminal');
    expect(within(row).getByRole('button', { name: 'Session term-1 (Working): show it' })).toBeTruthy();
    // Its tree has the same shape: main agent, then its agents (tokens are lower bounds, so with a "~").
    expect(within(row).getByTestId('running-agent-term-1-a').textContent).toContain('▸ Bash · ~600 tok');
  });

  it('gets a project row named after the folder when no listed project has it, even with no app session running at all', async () => {
    await mount(snapshotOf([terminal('term-2', { projectPath: 'C:\\somewhere\\Scratch' })]), { displayed: [] });
    const group = await screen.findByTestId('running-terminal-projects');
    expect(within(group).getByRole('button', { name: /Scratch/ }).getAttribute('aria-expanded')).toBe('true');
    expect(within(group).getByTestId('running-terminal-session-term-2')).toBeTruthy();
    expect(screen.queryByText('No sessions running')).toBeNull();
  });

  it('shows the empty state when nothing runs: no app session, no terminal session', async () => {
    await mount(snapshotOf([]), { displayed: [] });
    expect(await screen.findByText('No sessions running')).toBeTruthy();
  });

  it('closes and opens a terminal project row, aria-expanded telling which', async () => {
    await mount(snapshotOf([terminal('term-2', { projectPath: 'C:\\somewhere\\Scratch' })]), { displayed: [] });
    const header = await tree().findByRole('button', { name: /Scratch/ });
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('running-terminal-session-term-2')).toBeNull();
  });

  it('shows the graph of a terminal session that has no chat, and releases it on a second click', async () => {
    await mount(snapshotOf([s1, T1]));
    const button = await tree().findByRole('button', { name: 'Session term-1 (Working): show it' });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));
    expect(where()).toBe('/');
    expect(screen.getByTestId('running-pane-title').textContent).toBe('Graph: term-1');
    expect(tree().getByRole('button', { name: 'Session term-1 (Working): show it' }).getAttribute('aria-pressed')).toBe('true');
    await findGraphNode('session:term-1');
    expect(graphNode('session:term-1')?.getAttribute('aria-pressed')).toBe('true');
    // The terminal badge says where it comes from; there is no explanatory note about how it is read.
    expect(screen.queryByTestId('monitor-derived-note')).toBeNull();

    fireEvent.click(tree().getByRole('button', { name: 'Session term-1 (Working): show it' }));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
  });

  it('does not open the chat of a terminal session the app already knows either: its row only focuses the session', async () => {
    await mount(snapshotOf([s1, terminal('term-3', { openSessionId: 'chat-7' })]));
    fireEvent.click(await tree().findByRole('button', { name: 'Session term-3 (Working): show it' }));
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));
    expect(where()).toBe('/');
    expect(tree().getByRole('button', { name: 'Session term-3 (Working): show it' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(tree().getByRole('button', { name: 'Session term-3 (Working): show it' }));
    await waitFor(() => expect(pane().dataset.pane).toBe('overview'));
    expect(where()).toBe('/');
  });

  it('keeps an idle terminal session in the list while it is the focused one, and drops it once it is released', async () => {
    await mount(snapshotOf([s1, T1]));
    fireEvent.click(await tree().findByRole('button', { name: 'Session term-1 (Working): show it' }));
    await waitFor(() => expect(pane().dataset.pane).toBe('graph'));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    current = snapshotOf([s1, { ...T1, state: 'idle' }]);
    await tick(1100);
    expect(screen.getByTestId('running-terminal-session-term-1')).toBeTruthy();

    fireEvent.click(tree().getByRole('button', { name: /Session term-1/ }));
    await waitFor(() => expect(screen.queryByTestId('running-terminal-session-term-1')).toBeNull());
  });
});

describe('what the list does while the monitor has not answered', () => {
  it('draws the usual session rows alone, without a tree, until the first answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRunning(<><RunningTabSwitch /><SidebarStandIn displayed={[ALPHA]} /></>);
    expect(await screen.findByRole('link', { name: /Session s1/ })).toBeTruthy();
    expect(screen.queryByTestId('running-session-s1')).toBeNull();
  });

  it('says the monitor cannot be reached, with a retry, when the first answer is not the monitor\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    renderRunning(<><RunningTabSwitch /><SidebarStandIn displayed={[ALPHA]} /></>);
    const alert = await screen.findByTestId('monitor-error');
    expect(alert.textContent).toContain('Cannot reach the monitor API');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('outside the Running tab', () => {
  it('draws no tree and no terminal row: the session rows are the plain ones', async () => {
    const api = await mount(snapshotOf([s1, terminal('term-1')]), { tab: false });
    // Not the Running branch at all here: the stand-in always renders it, but without the tab on there is no snapshot.
    expect(screen.queryByTestId('running-session-s1')).toBeNull();
    expect(screen.queryByTestId('running-terminal-session-term-1')).toBeNull();
    expect(api.paths).toEqual([]);
  });
});
