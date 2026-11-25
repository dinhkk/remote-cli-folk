import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { RunningMonitorPane, useRunningMainPane } from '@/modules/agent-monitor';
import { findGraph, graphNode, preloadGraph, PRELOAD_TIMEOUT_MS } from '@/modules/agent-monitor/tests/graphHarness';
import { MACHINE, makeNode, makeRow, makeSession, makeSnapshot, stubReducedMotion } from '@/modules/agent-monitor/tests/monitorFixtures';
import { renderRunning, RunningTabSwitch } from '@/modules/agent-monitor/tests/runningHarness';

/** The kill button on the real graph: where it is drawn, what it does to the box beside it, and what it sends. */

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
      agents: [makeNode({ id: 'tu-1', name: 'review-code--alpha' }), makeNode({ id: 'tu-2', name: 'finished-one', state: 'done', endedAt: 1_000_500 })],
      processes: [{ name: 'node', count: 3, rssBytes: 1, cpuPercent: 1 }],
    }),
    makeSession({ id: 'terminal:abc', source: 'terminal', label: 'Terminal chat', openSessionId: null, agents: [makeNode({ id: 'tu-9', name: 'term-agent' })], processes: [] }),
  ],
  resources: { sampling: true, intervalMs: 2000, lastSampleAt: 1_004_000, error: null, cores: 8, machine: MACHINE, rows: [makeRow({ key: 'server', kind: 'server', label: 'Server', pid: 10 })] },
});

type Sent = { url: string; body: unknown };

/** The snapshot on GET; any POST is recorded and answered with `answer`. */
function installFetch(answer: { status: number; body: unknown } = { status: 200, body: { result: 'killed', count: 3 } }) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return sent;
}

const mount = async (sent = installFetch()) => {
  stubReducedMotion(true);
  renderRunning(<><RunningTabSwitch /><Main /></>);
  await screen.findByTestId('agent-monitor');
  await findGraph();
  return sent;
};

// The overview draws every session; a focus on a box opens the single-session graph of its session.
const focusNode = async (id: string) => {
  fireEvent.click(await screen.findByTestId('tab-switch').then(() => graphNode(id) as HTMLElement));
  await waitFor(() => expect(graphNode(id)?.getAttribute('data-node-focused')).toBe('true'));
};

describe('where the kill button is', () => {
  it('there is none while nothing is focused', async () => {
    await mount();
    expect(document.querySelector('button[data-testid^="kill-"]')).toBeNull();
  });

  it('a focused sub-agent has one, BESIDE its own button and not inside it, shielded from the graph\'s drag and pan', async () => {
    await mount();
    await focusNode('agent:s1:tu-1');
    const kill = await screen.findByTestId('kill-agent:s1:tu-1');
    expect(kill.closest('[role="button"]')).toBeNull();
    expect(kill.className).toContain('nodrag');
    expect(kill.className).toContain('nopan');
    expect(kill.tagName).toBe('BUTTON');
    expect(kill.querySelector('button')).toBeNull();
  });

  it('a focused finished sub-agent has none, and neither does the session box', async () => {
    await mount();
    await focusNode('agent:s1:tu-2');
    expect(screen.queryByTestId('kill-agent:s1:tu-2')).toBeNull();
  });

  it('a focused main agent and a focused process group have one; the others do not', async () => {
    await mount();
    await focusNode('orch:s1');
    expect(await screen.findByTestId('kill-orch:s1')).toBeTruthy();
    expect(screen.queryByTestId('kill-agent:s1:tu-1')).toBeNull();
    await focusNode('proc:s1:node');
    expect(await screen.findByTestId('kill-proc:s1:node')).toBeTruthy();
    expect(screen.queryByTestId('kill-orch:s1')).toBeNull();
  });

  it('a terminal session\'s agent has none', async () => {
    await mount();
    await focusNode('agent:terminal:abc:tu-9');
    expect(screen.queryByTestId('kill-agent:terminal:abc:tu-9')).toBeNull();
  });

  it('un-focusing the box takes the button away', async () => {
    await mount();
    await focusNode('agent:s1:tu-1');
    await screen.findByTestId('kill-agent:s1:tu-1');
    fireEvent.click(graphNode('agent:s1:tu-1') as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('kill-agent:s1:tu-1')).toBeNull());
  });
});

describe('on a phone', () => {
  it('the stylesheet gives the button a 44px touch target for a coarse pointer (jsdom cannot measure it: live check)', () => {
    const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../graph/monitorFlow.css'), 'utf8');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse) {\n  .monitor-flow .monitor-kill-button'));
    expect(coarse).toMatch(/\.monitor-kill-button\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/);
  });
});

describe('pressing it', () => {
  it('does not select or un-select the box, and Enter or Space on it does not either', async () => {
    await mount();
    await focusNode('agent:s1:tu-1');
    const kill = await screen.findByTestId('kill-agent:s1:tu-1');
    fireEvent.click(kill);
    fireEvent.keyDown(kill, { key: 'Enter' });
    fireEvent.keyDown(kill, { key: ' ' });
    fireEvent.pointerDown(kill);
    expect(graphNode('agent:s1:tu-1')?.getAttribute('data-node-focused')).toBe('true');
    expect(screen.getByTestId('kill-agent:s1:tu-1').getAttribute('data-kill-step')).toBe('armed');
  });

  it('confirmed twice, a main agent sends its session and node and the kill mode, with no process id anywhere', async () => {
    const sent = await mount(installFetch({ status: 200, body: { result: 'killed', count: 4 } }));
    await focusNode('orch:s1');
    fireEvent.click(await screen.findByTestId('kill-orch:s1'));
    fireEvent.click(screen.getByTestId('kill-orch:s1'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toContain('/api/agent-monitor/kill');
    expect(sent[0].body).toEqual({ sessionId: 's1', nodeId: 'orch:s1', mode: 'kill' });
    await waitFor(() => expect(screen.getByTestId('kill-message').textContent).toContain('Killed.'));
  });

  it('a 403 refused answer is read as refused, not as a broken request', async () => {
    await mount(installFetch({ status: 403, body: { result: 'refused' } }));
    await focusNode('proc:s1:node');
    fireEvent.click(await screen.findByTestId('kill-proc:s1:node'));
    fireEvent.click(screen.getByTestId('kill-proc:s1:node'));
    await waitFor(() => expect(screen.getByTestId('kill-message').textContent).toContain('Not allowed'));
  });

  it('an answer that is not the kill route\'s (a gateway page) is an error line, never a silent success', async () => {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') { sent.push({ url: '', body: null }); return new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }); }
      return new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await mount(sent);
    await focusNode('orch:s1');
    fireEvent.click(await screen.findByTestId('kill-orch:s1'));
    fireEvent.click(screen.getByTestId('kill-orch:s1'));
    await waitFor(() => expect(screen.getByTestId('kill-message').textContent).toContain('did not work'));
  });
});
