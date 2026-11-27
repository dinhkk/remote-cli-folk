import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { LazyMonitorGraph } from '@/modules/agent-monitor/graph/MonitorGraphLazy';
import { findGraph, findGraphNode, graphEdge, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { makeNode, makeSession } from '@/modules/agent-monitor/tests/monitorFixtures';
import type { AgentMonitorSession } from '@/shared/types';

/**
 * The live graph on its own (React Flow in jsdom, with the boxes given their size by the graph itself): the boxes and
 * connectors it draws for a set of sessions, what a click or a key press on a box does, the focused box, and what a
 * snapshot refresh keeps. A real mouse drag is replayed through React Flow's own drag handling; the pure rules behind it are
 * in nodePositions.test.ts and useDragClickGuard.test.ts.
 */

beforeAll(preloadGraph, PRELOAD_TIMEOUT_MS);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SESSION: AgentMonitorSession = makeSession({
  id: 's1',
  label: 'Review Alpha',
  foldedFinished: 2,
  agents: [
    makeNode({ id: 'a1', name: 'review-code--alpha', tokens: 1200, toolCalls: 3, lastToolName: 'Grep', tokensPerSecond: 50 }),
    makeNode({ id: 'a2', name: 'ba--alpha', state: 'waiting' }),
  ],
  processes: [{ name: 'node', count: 3, rssBytes: 200 * 1024 * 1024, cpuPercent: 12.4 }],
});

const draw = async (sessions: AgentMonitorSession[], props: Partial<Parameters<typeof LazyMonitorGraph>[0]> = {}) => {
  const onSelectNode = vi.fn();
  const view = render(<LazyMonitorGraph sessions={sessions} now={1_005_000} animate={false} onSelectNode={onSelectNode} {...props} />);
  await findGraph();
  return { ...view, onSelectNode };
};

describe('the graph\'s boxes and connectors', () => {
  it('shows a placeholder first, then one box per session, main agent, agent, process group and the finished fold', async () => {
    const onSelectNode = vi.fn();
    render(<LazyMonitorGraph sessions={[SESSION]} now={1_005_000} animate={false} onSelectNode={onSelectNode} />);
    expect(screen.getByTestId('monitor-graph-loading').getAttribute('aria-busy')).toBe('true');

    await findGraph();
    expect(screen.queryByTestId('monitor-graph-loading')).toBeNull();
    const kinds = [...document.querySelectorAll('[data-node-id]')].map((element) => element.getAttribute('data-node-kind'));
    expect(kinds).toEqual(['session', 'orchestrator', 'agent', 'agent', 'folded', 'process']);
    expect(graphNode('session:s1')?.textContent).toContain('Review Alpha');
    expect(graphNode('orch:s1')?.textContent).toContain('orchestrator');
    expect(graphNode('agent:s1:a1')?.textContent).toContain('review-code--alpha');
    expect(graphNode('agent:s1:a1')?.textContent).toContain('1.2k');
    expect(graphNode('folded:s1')?.textContent).toBe('+2 finished');
    expect(graphNode('proc:s1:node')?.getAttribute('title')).toContain('Processes 3');
    expect(graphNode('proc:s1:node')?.textContent).toContain('200 MB');
  });

  it('draws connector dots on the boxes and an edge for each parent-child pair; the fold has neither', async () => {
    await draw([SESSION]);
    // The session has an outgoing dot only, the main agent one each side, the agents and the process group an incoming one.
    const handlesOf = (id: string) => [...(graphNode(id)?.closest('.react-flow__node')?.querySelectorAll('.react-flow__handle') ?? [])].map((handle) => handle.getAttribute('data-handlepos'));
    expect(handlesOf('session:s1')).toEqual(['right']);
    expect(handlesOf('orch:s1')).toEqual(['left', 'right']);
    expect(handlesOf('agent:s1:a1')).toEqual(['left']);
    expect(handlesOf('proc:s1:node')).toEqual(['left']);
    expect(handlesOf('folded:s1')).toEqual([]);

    await waitFor(() => expect(graphEdge('session:s1>orch:s1')).not.toBeNull());
    expect(graphEdge('orch:s1>agent:s1:a1')?.getAttribute('data-edge-flowing')).toBe('true');
    expect(graphEdge('orch:s1>proc:s1:node')?.getAttribute('data-edge-kind')).toBe('process');
    // Lines are decoration for a screen reader: the boxes carry the names and states.
    expect(graphEdge('orch:s1>agent:s1:a1')?.closest('.react-flow__edge')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives the boxes the accessible names and states the list uses, and makes them buttons', async () => {
    await draw([SESSION]);
    const agent = graphNode('agent:s1:a2')!;
    expect(agent.getAttribute('role')).toBe('button');
    expect(agent.getAttribute('tabindex')).toBe('0');
    expect(agent.getAttribute('aria-pressed')).toBe('false');
    expect(agent.getAttribute('aria-label')).toBe('Agent ba--alpha (Waiting for permission): focus it');
    expect(agent.dataset.nodeState).toBe('waiting');
    expect(graphNode('session:s1')?.getAttribute('aria-label')).toBe('Session Review Alpha: show it');
    expect(graphNode('proc:s1:node')?.getAttribute('aria-label')).toBe('Child processes node: 3 running, 200 MB of memory');
    // The fold is not a control.
    expect(graphNode('folded:s1')?.getAttribute('role')).toBe('img');
    expect(graphNode('folded:s1')?.getAttribute('tabindex')).toBeNull();
  });

  it('lets the user drag, pan and zoom but not connect, delete or select', async () => {
    await draw([SESSION]);
    const flow = document.querySelector('.react-flow')!;
    expect(flow.querySelector('.react-flow__handle.connectionindicator')).toBeNull();
    expect(flow.querySelectorAll('.react-flow__node.draggable').length).toBeGreaterThan(0);
    expect(flow.querySelector('.react-flow__node.selectable')).toBeNull();
    // Deleting is off: the Backspace/Delete key does nothing to the picture.
    fireEvent.keyDown(graphNode('agent:s1:a1')!, { key: 'Delete' });
    fireEvent.keyDown(graphNode('agent:s1:a1')!, { key: 'Backspace' });
    expect(graphNode('agent:s1:a1')).not.toBeNull();
    expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
  });

  it('still renders the zoom, fit and reset controls (the stylesheet hides them), keeps the attribution, and has no minimap', async () => {
    await draw([SESSION]);
    const controls = document.querySelector('.react-flow__controls')!;
    expect(controls.getAttribute('aria-label')).toBe('Graph view controls');
    for (const name of ['Zoom in', 'Zoom out', 'Fit the graph to the view', 'Reset layout']) {
      expect(controls.querySelector(`button[aria-label="${name}"]`), name).not.toBeNull();
    }
    expect(controls.querySelector('.react-flow__controls-interactive')).toBeNull();
    expect(document.querySelector('.react-flow__attribution')).not.toBeNull();
    expect(document.querySelector('.react-flow__minimap')).toBeNull();
  });

  it('notes the agents and process groups it could not draw', async () => {
    const processes = Array.from({ length: 8 }, (_, index) => ({ name: `tool${index}`, count: 1, rssBytes: 1024, cpuPercent: 0 }));
    await draw([makeSession({ id: 's1', processes })]);
    expect(screen.getByTestId('monitor-graph-omitted-processes').textContent).toBe('3 more process groups not shown.');
  });
});

describe('clicks, keys and focus', () => {
  it('a click on a session box reports it with a null node id; on any other box with that box\'s id', async () => {
    const { onSelectNode } = await draw([SESSION]);
    fireEvent.click(graphNode('session:s1')!);
    expect(onSelectNode).toHaveBeenLastCalledWith('s1', null);
    fireEvent.click(graphNode('orch:s1')!);
    expect(onSelectNode).toHaveBeenLastCalledWith('s1', 'orch:s1');
    fireEvent.click(graphNode('agent:s1:a1')!);
    expect(onSelectNode).toHaveBeenLastCalledWith('s1', 'agent:s1:a1');
    fireEvent.click(graphNode('proc:s1:node')!);
    expect(onSelectNode).toHaveBeenLastCalledWith('s1', 'proc:s1:node');
    expect(onSelectNode).toHaveBeenCalledTimes(4);
  });

  it('Enter and Space select a box once each, and the fold does nothing', async () => {
    const { onSelectNode } = await draw([SESSION]);
    fireEvent.keyDown(graphNode('agent:s1:a2')!, { key: 'Enter' });
    expect(onSelectNode).toHaveBeenLastCalledWith('s1', 'agent:s1:a2');
    fireEvent.keyDown(graphNode('proc:s1:node')!, { key: ' ' });
    expect(onSelectNode).toHaveBeenLastCalledWith('s1', 'proc:s1:node');
    fireEvent.keyDown(graphNode('agent:s1:a2')!, { key: 'a' });
    fireEvent.click(graphNode('folded:s1')!);
    expect(onSelectNode).toHaveBeenCalledTimes(2);
  });

  it('rings and presses the focused box only', async () => {
    const { rerender } = await draw([SESSION], { highlightId: 'agent:s1:a1' });
    expect(graphNode('agent:s1:a1')?.getAttribute('aria-pressed')).toBe('true');
    expect(graphNode('agent:s1:a1')?.querySelector('[data-focus-ring]')).not.toBeNull();
    expect(graphNode('agent:s1:a2')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('[data-focus-ring]')).toHaveLength(1);

    rerender(<LazyMonitorGraph sessions={[SESSION]} now={1_005_000} animate={false} highlightId="proc:s1:node" onSelectNode={vi.fn()} />);
    await waitFor(() => expect(graphNode('proc:s1:node')?.querySelector('[data-focus-ring]')).not.toBeNull());
    expect(graphNode('agent:s1:a1')?.querySelector('[data-focus-ring]')).toBeNull();
    expect(document.querySelectorAll('[data-focus-ring]')).toHaveLength(1);
  });
});

/** A mouse event as React Flow's drag library reads it (it takes the window from `event.view`, which jsdom's synthetic events lack). */
const mouse = (type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'view', { value: window });
  return event;
};
const positionOf = (id: string) => graphNode(id)?.closest<HTMLElement>('.react-flow__node')?.style.transform;
/**
 * Drags a box by a few pixels with the mouse and returns once the drop is done. clickOnRelease sends the click a browser may
 * dispatch right after the mouse is released, in the same task as the release.
 */
const dragBox = async (id: string, clickOnRelease = false) => {
  const box = graphNode(id)!.closest('.react-flow__node')!;
  await act(async () => { box.dispatchEvent(mouse('mousedown', 10, 10)); });
  await act(async () => { box.dispatchEvent(mouse('mousemove', 60, 40)); });
  await act(async () => { box.dispatchEvent(mouse('mousemove', 90, 70)); });
  if (clickOnRelease) {
    act(() => {
      box.dispatchEvent(mouse('mouseup', 90, 70));
      fireEvent.click(graphNode(id)!);
    });
  } else {
    await act(async () => { box.dispatchEvent(mouse('mouseup', 90, 70)); });
  }
};

describe('dragging a box', () => {
  it('moves the box, and a click that ends the drag does not select it (a later click does)', async () => {
    const { onSelectNode } = await draw([SESSION]);
    const before = positionOf('agent:s1:a1');

    // The click a browser may send on release: the drag is not a click.
    await dragBox('agent:s1:a1', true);
    expect(positionOf('agent:s1:a1')).not.toBe(before);
    expect(onSelectNode).not.toHaveBeenCalled();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    fireEvent.click(graphNode('agent:s1:a1')!);
    expect(onSelectNode).toHaveBeenCalledTimes(1);
  });

  it('keeps the dragged position through a snapshot refresh, while a new box takes the layout position', async () => {
    const { rerender } = await draw([SESSION]);
    await dragBox('agent:s1:a1');
    const dragged = positionOf('agent:s1:a1');
    const untouched = positionOf('agent:s1:a2');

    const refreshed = makeSession({ ...SESSION, agents: [makeNode({ id: 'a1', name: 'review-code--alpha', tokens: 9000 }), makeNode({ id: 'a2', name: 'ba--alpha', state: 'waiting' }), makeNode({ id: 'a3', name: 'new-agent' })] });
    rerender(<LazyMonitorGraph sessions={[refreshed]} now={1_006_000} animate={false} onSelectNode={vi.fn()} />);
    await findGraphNode('agent:s1:a3');

    expect(graphNode('agent:s1:a1')?.textContent).toContain('9k');
    expect(positionOf('agent:s1:a1')).toBe(dragged);
    expect(positionOf('agent:s1:a2')).toBe(untouched);
    // The new box sits in the leaf column at the layout's row, not where the dragged one is.
    expect(positionOf('agent:s1:a3')).toMatch(/^translate\(356px,/);
  });

  it('forgets the position of a box that left: back in the picture it starts from the layout again', async () => {
    const { rerender } = await draw([SESSION]);
    const layoutPosition = positionOf('agent:s1:a1');
    await dragBox('agent:s1:a1');
    expect(positionOf('agent:s1:a1')).not.toBe(layoutPosition);

    const without = makeSession({ ...SESSION, agents: [makeNode({ id: 'a2', name: 'ba--alpha', state: 'waiting' })] });
    rerender(<LazyMonitorGraph sessions={[without]} now={1_005_000} animate={false} onSelectNode={vi.fn()} />);
    await waitFor(() => expect(graphNode('agent:s1:a1')).toBeNull());

    rerender(<LazyMonitorGraph sessions={[SESSION]} now={1_005_000} animate={false} onSelectNode={vi.fn()} />);
    await findGraphNode('agent:s1:a1');
    expect(positionOf('agent:s1:a1')).toBe(layoutPosition);
  });

  it('puts every box back where the layout says with the reset control', async () => {
    await draw([SESSION]);
    const layoutPosition = positionOf('agent:s1:a1');
    await dragBox('agent:s1:a1');
    expect(positionOf('agent:s1:a1')).not.toBe(layoutPosition);

    fireEvent.click(document.querySelector('button[aria-label="Reset layout"]')!);
    await waitFor(() => expect(positionOf('agent:s1:a1')).toBe(layoutPosition));
  });
});

describe('a snapshot refresh', () => {
  it('updates what the boxes say and adds new boxes without redrawing the flow (the view is not fitted again on a tick)', async () => {
    const { rerender } = await draw([SESSION]);
    const flow = document.querySelector('.react-flow');
    const viewport = document.querySelector('.react-flow__viewport');

    const refreshed = makeSession({ ...SESSION, agents: [makeNode({ id: 'a1', name: 'review-code--alpha', tokens: 9000, toolCalls: 7 }), makeNode({ id: 'a2', name: 'ba--alpha', state: 'done', endedAt: 1_004_000 }), makeNode({ id: 'a3', name: 'new-agent' })] });
    rerender(<LazyMonitorGraph sessions={[refreshed]} now={1_006_000} animate={false} onSelectNode={vi.fn()} />);

    await findGraphNode('agent:s1:a3');
    expect(graphNode('agent:s1:a1')?.textContent).toContain('9k');
    expect(graphNode('agent:s1:a2')?.dataset.nodeState).toBe('done');
    // The same React Flow instance: the user's pan and zoom stay.
    expect(document.querySelector('.react-flow')).toBe(flow);
    expect(document.querySelector('.react-flow__viewport')).toBe(viewport);
  });

  it('starts a fresh, fitted view when the set of shown sessions changes, and drops the boxes that left', async () => {
    const { rerender } = await draw([SESSION]);
    const flow = document.querySelector('.react-flow');

    rerender(<LazyMonitorGraph sessions={[SESSION, makeSession({ id: 's2', label: 'Other' })]} now={1_005_000} animate={false} onSelectNode={vi.fn()} />);
    await findGraphNode('session:s2');
    expect(document.querySelector('.react-flow')).not.toBe(flow);

    rerender(<LazyMonitorGraph sessions={[makeSession({ id: 's2', label: 'Other' })]} now={1_005_000} animate={false} onSelectNode={vi.fn()} />);
    await waitFor(() => expect(graphNode('session:s1')).toBeNull());
    expect(graphNode('session:s2')).not.toBeNull();
  });

  it('starts a fresh, fitted view when the child process boxes are turned on or off (they would sit outside a view fitted without them)', async () => {
    const { rerender } = await draw([SESSION], { showProcesses: false });
    const flow = document.querySelector('.react-flow');
    expect(graphNode('proc:s1:node')).toBeNull();

    rerender(<LazyMonitorGraph sessions={[SESSION]} now={1_005_000} animate={false} onSelectNode={vi.fn()} showProcesses />);
    await findGraphNode('proc:s1:node');
    expect(document.querySelector('.react-flow')).not.toBe(flow);
  });

  it('puts boxes where the layout says at first: left to right, session then main agent then leaves', async () => {
    await draw([SESSION]);
    const xOf = (id: string) => Number(/translate\(([-\d.]+)px/.exec(graphNode(id)?.closest<HTMLElement>('.react-flow__node')?.style.transform ?? '')?.[1]);
    expect(xOf('session:s1')).toBeLessThan(xOf('orch:s1'));
    expect(xOf('orch:s1')).toBeLessThan(xOf('agent:s1:a1'));
    expect(xOf('agent:s1:a1')).toBe(xOf('proc:s1:node'));
  });
});

describe('motion', () => {
  it('flows a working edge and animates the working boxes only with motion on', async () => {
    const { rerender } = await draw([SESSION], { animate: true });
    expect(graphEdge('orch:s1>agent:s1:a1')?.getAttribute('class')).toContain('monitor-edge-flow');
    expect(graphEdge('session:s1>orch:s1')?.getAttribute('class')).toContain('monitor-edge-flow');
    expect(graphNode('agent:s1:a1')?.querySelector('.monitor-spin')).not.toBeNull();
    expect(graphNode('agent:s1:a1')?.querySelector('.monitor-pulse')).not.toBeNull();
    expect(graphNode('agent:s1:a2')?.querySelector('.monitor-blink')).not.toBeNull();

    rerender(<LazyMonitorGraph sessions={[SESSION]} now={1_005_000} animate={false} onSelectNode={vi.fn()} />);
    await waitFor(() => expect(graphNode('agent:s1:a1')?.querySelector('.monitor-spin')).toBeNull());
    for (const animated of ['.monitor-edge-flow', '.monitor-pulse', '.monitor-blink', '.monitor-enter', '.monitor-done', '.monitor-shake']) {
      expect(document.querySelector(animated), animated).toBeNull();
    }
    // Colour and glyph still tell the state.
    expect(graphNode('agent:s1:a1')?.querySelector('div')?.className).toContain('border-blue-500');
    expect(graphNode('agent:s1:a1')?.querySelector('[data-state-glyph="running"]')).not.toBeNull();
    expect(graphNode('agent:s1:a2')?.querySelector('div')?.className).toContain('border-amber-500');
  });
});
