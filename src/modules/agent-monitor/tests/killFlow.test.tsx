import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { KillButton } from '@/modules/agent-monitor/graph/KillButton';
import { KillFlowProvider } from '@/modules/agent-monitor/graph/KillFlowContext';
import { KillMessage } from '@/modules/agent-monitor/graph/KillMessage';
import { KILL_ARM_MS, KILL_MESSAGE_MS, KILLING_MAX_MS, STOP_ESCALATE_MS } from '@/modules/agent-monitor/graph/killability';
import { layoutMonitorTree, type GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { makeNode, makeSession } from '@/modules/agent-monitor/tests/monitorFixtures';
import type { AgentMonitorKillRequest, AgentMonitorKillResponse, AgentMonitorSession } from '@/shared/types';

/**
 * The kill button's flow (confirm twice, stop then escalate, wait for the snapshot) with the clock under the test's control.
 * The box itself is not drawn: the button and the pane's message line are what is under test, and they only need a node.
 */

const sessionWith = (overrides: Partial<AgentMonitorSession> = {}): AgentMonitorSession =>
  makeSession({ id: 's1', agents: [makeNode({ id: 'a1' })], processes: [{ name: 'node', count: 3, rssBytes: 1, cpuPercent: 1 }], ...overrides });
const nodeOf = (session: AgentMonitorSession, id: string): GraphNode => layoutMonitorTree([session]).nodes.find((node) => node.id === id) as GraphNode;

type Sender = (request: AgentMonitorKillRequest) => Promise<AgentMonitorKillResponse>;

function Harness({ sessions, node, send, show = true }: { sessions: AgentMonitorSession[]; node: GraphNode; send: Sender; show?: boolean }) {
  return (
    <KillFlowProvider sessions={sessions} send={send}>
      <div className="relative">{show && <KillButton node={node} />}</div>
      <KillMessage />
    </KillFlowProvider>
  );
}

const mount = (session: AgentMonitorSession, nodeId: string, send: Sender) => {
  const node = nodeOf(session, nodeId);
  const view = render(<Harness sessions={[session]} node={node} send={send} />);
  return {
    ...view,
    rerenderWith: (sessions: AgentMonitorSession[], show = true) => view.rerender(<Harness sessions={sessions} node={node} send={send} show={show} />),
  };
};

const button = (nodeId: string) => screen.getByTestId(`kill-${nodeId}`);
const step = (nodeId: string) => button(nodeId).getAttribute('data-kill-step');
const press = async (nodeId: string) => { await act(async () => { fireEvent.click(button(nodeId)); }); };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const answering = (...responses: AgentMonitorKillResponse[]) => vi.fn<Sender>(async () => responses.shift() ?? { result: 'killed' });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('confirming twice', () => {
  it('the first press only arms the button and asks; nothing is sent', async () => {
    const send = answering();
    mount(sessionWith(), 'orch:s1', send);
    expect(step('orch:s1')).toBe('idle');
    await press('orch:s1');
    expect(step('orch:s1')).toBe('armed');
    expect(button('orch:s1').textContent).toContain('Kill whole session?');
    expect(send).not.toHaveBeenCalled();
  });

  it('an unconfirmed press goes back to idle after the confirm window', async () => {
    mount(sessionWith(), 'orch:s1', answering());
    await press('orch:s1');
    await advance(KILL_ARM_MS - 100);
    expect(step('orch:s1')).toBe('armed');
    await advance(200);
    expect(step('orch:s1')).toBe('idle');
  });

  it('the second press sends the right request, and presses while it is out send nothing more', async () => {
    let resolve: (value: AgentMonitorKillResponse) => void = () => undefined;
    const send = vi.fn<Sender>(() => new Promise<AgentMonitorKillResponse>((done) => { resolve = done; }));
    mount(sessionWith(), 'orch:s1', send);
    await press('orch:s1');
    await press('orch:s1');
    expect(send).toHaveBeenCalledWith({ sessionId: 's1', nodeId: 'orch:s1', mode: 'kill' });
    expect(step('orch:s1')).toBe('pending');
    expect(button('orch:s1').getAttribute('aria-busy')).toBe('true');
    expect((button('orch:s1') as HTMLButtonElement).disabled).toBe(true);
    await press('orch:s1');
    await press('orch:s1');
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ result: 'killed', count: 4 }); });
  });

  it('a process group says how many it will kill before the second press', async () => {
    mount(sessionWith(), 'proc:s1:node', answering());
    await press('proc:s1:node');
    expect(button('proc:s1:node').textContent).toBe('Kill 3 node processes?');
  });

  it('a process group kill sends mode kill for that node', async () => {
    const send = answering({ result: 'killed', count: 3 });
    mount(sessionWith(), 'proc:s1:node', send);
    await press('proc:s1:node');
    await press('proc:s1:node');
    expect(send).toHaveBeenCalledWith({ sessionId: 's1', nodeId: 'proc:s1:node', mode: 'kill' });
  });
});

describe('after a kill', () => {
  it('the box reads "killing" until the snapshot shows the change, then it is done', async () => {
    const session = sessionWith();
    const view = mount(session, 'orch:s1', answering({ result: 'killed', count: 4 }));
    await press('orch:s1');
    await press('orch:s1');
    expect(step('orch:s1')).toBe('killing');
    expect(button('orch:s1').textContent).toContain('Killing');
    view.rerenderWith([sessionWith({ state: 'idle', agents: [makeNode({ id: 'a1', state: 'stopped' })] })]);
    expect(step('orch:s1')).toBe('idle');
  });

  it('"killing" ends on its own after the cap when the snapshot never changes', async () => {
    mount(sessionWith(), 'orch:s1', answering({ result: 'killed' }));
    await press('orch:s1');
    await press('orch:s1');
    await advance(KILLING_MAX_MS - 100);
    expect(step('orch:s1')).toBe('killing');
    await advance(200);
    expect(step('orch:s1')).toBe('idle');
  });

  it('a refused or failed kill leaves the button usable again at once', async () => {
    for (const result of ['refused', 'error', 'unavailable'] as const) {
      cleanup();
      mount(sessionWith(), 'orch:s1', answering({ result }));
      await press('orch:s1');
      await press('orch:s1');
      expect(step('orch:s1'), result).toBe('idle');
    }
  });
});

describe('stopping an agent', () => {
  it('asks the agent to stop (not to be killed), and a stopped agent that ends within the time leaves nothing to escalate', async () => {
    const send = answering({ result: 'stopped' });
    const view = mount(sessionWith(), 'agent:s1:a1', send);
    await press('agent:s1:a1');
    expect(button('agent:s1:a1').textContent).toContain('Stop agent?');
    await press('agent:s1:a1');
    expect(send).toHaveBeenCalledWith({ sessionId: 's1', nodeId: 'agent:s1:a1', mode: 'stop' });
    expect(step('agent:s1:a1')).toBe('waiting');
    await advance(2_000);
    view.rerenderWith([sessionWith({ agents: [makeNode({ id: 'a1', state: 'stopped' })] })]);
    expect(step('agent:s1:a1')).toBe('idle');
    await advance(STOP_ESCALATE_MS);
    expect(step('agent:s1:a1')).toBe('idle');
  });

  it('an agent still working STOP_ESCALATE_MS after the press (not after the answer) offers a force kill of the session, confirmed twice', async () => {
    const send = vi.fn<Sender>(async (request) => {
      if (request.mode === 'stop') {
        await new Promise((resolve) => { setTimeout(resolve, 2_000); });
        return { result: 'stopped' };
      }
      return { result: 'killed', count: 5 };
    });
    mount(sessionWith(), 'agent:s1:a1', send);
    await press('agent:s1:a1');
    await press('agent:s1:a1');
    await advance(2_000);
    expect(step('agent:s1:a1')).toBe('waiting');
    await advance(STOP_ESCALATE_MS - 2_000 - 100);
    expect(step('agent:s1:a1')).toBe('waiting');
    await advance(200);
    expect(step('agent:s1:a1')).toBe('escalate');
    expect(button('agent:s1:a1').textContent).toContain('Force kill session');

    await press('agent:s1:a1');
    expect(step('agent:s1:a1')).toBe('escalateArmed');
    expect(button('agent:s1:a1').textContent).toContain('Kill whole session?');
    expect(send).toHaveBeenCalledTimes(1);
    await press('agent:s1:a1');
    expect(send).toHaveBeenLastCalledWith({ sessionId: 's1', nodeId: 'agent:s1:a1', mode: 'kill' });
  });

  it('an agent with no handle goes straight to "Kill session"', async () => {
    mount(sessionWith(), 'agent:s1:a1', answering({ result: 'no-handle' }));
    await press('agent:s1:a1');
    await press('agent:s1:a1');
    expect(step('agent:s1:a1')).toBe('escalate');
    expect(button('agent:s1:a1').textContent).toContain('Kill session');
    expect(screen.getByTestId('kill-message').textContent).toContain('kill the session instead');
  });

  it('an unconfirmed escalation offer stays offered', async () => {
    mount(sessionWith(), 'agent:s1:a1', answering({ result: 'no-handle' }));
    await press('agent:s1:a1');
    await press('agent:s1:a1');
    await press('agent:s1:a1');
    expect(step('agent:s1:a1')).toBe('escalateArmed');
    await advance(KILL_ARM_MS + 100);
    expect(step('agent:s1:a1')).toBe('escalate');
  });
});

describe('what the user is told', () => {
  const cases: Array<[AgentMonitorKillResponse, string]> = [
    [{ result: 'killed', count: 2 }, 'Killed.'],
    [{ result: 'stopped' }, 'Stop sent'],
    [{ result: 'gone' }, 'Already gone.'],
    [{ result: 'no-handle' }, 'cannot be stopped on its own'],
    [{ result: 'unavailable' }, 'could not be found'],
    [{ result: 'refused' }, 'Not allowed'],
    [{ result: 'error' }, 'did not work'],
  ];

  it.each(cases)('%j reads as a line in the live region', async (response, text) => {
    mount(sessionWith(), response.result === 'stopped' || response.result === 'no-handle' ? 'agent:s1:a1' : 'orch:s1', answering(response));
    const id = response.result === 'stopped' || response.result === 'no-handle' ? 'agent:s1:a1' : 'orch:s1';
    await press(id);
    await press(id);
    const region = screen.getByTestId('kill-message');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain(text);
  });

  it('the live region is there, empty, before anything happened, and the line goes away by itself', async () => {
    mount(sessionWith(), 'orch:s1', answering({ result: 'refused' }));
    expect(screen.getByTestId('kill-message').textContent).toBe('');
    await press('orch:s1');
    await press('orch:s1');
    expect(screen.getByTestId('kill-message').textContent).not.toBe('');
    await advance(KILL_MESSAGE_MS + 100);
    expect(screen.getByTestId('kill-message').textContent).toBe('');
  });
});

describe('living outside the box', () => {
  it('a box that unmounts and comes back (the graph was rebuilt) keeps its confirmation, its timer and the result line', async () => {
    const session = sessionWith();
    const node = nodeOf(session, 'orch:s1');
    const send = answering({ result: 'refused' });
    const view = render(<Harness sessions={[session]} node={node} send={send} />);
    await press('orch:s1');
    view.rerender(<Harness sessions={[session]} node={node} send={send} show={false} />);
    expect(screen.queryByTestId('kill-orch:s1')).toBeNull();
    view.rerender(<Harness sessions={[session]} node={node} send={send} />);
    expect(step('orch:s1')).toBe('armed');
    await press('orch:s1');
    view.rerender(<Harness sessions={[session]} node={node} send={send} show={false} />);
    expect(screen.getByTestId('kill-message').textContent).toContain('Not allowed');
  });

  it('a kill that finishes after the pane is gone changes nothing and throws nothing', async () => {
    let resolve: (value: AgentMonitorKillResponse) => void = () => undefined;
    const send = vi.fn<Sender>(() => new Promise<AgentMonitorKillResponse>((done) => { resolve = done; }));
    const view = mount(sessionWith(), 'orch:s1', send);
    await press('orch:s1');
    await press('orch:s1');
    view.unmount();
    await act(async () => { resolve({ result: 'killed' }); });
    await advance(KILLING_MAX_MS + KILL_MESSAGE_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('without a provider there is no button at all', () => {
    const session = sessionWith();
    render(<KillButton node={nodeOf(session, 'orch:s1')} />);
    expect(screen.queryByTestId('kill-orch:s1')).toBeNull();
  });
});
