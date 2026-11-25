import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { sendMonitorKill } from '@/modules/agent-monitor/data/sendMonitorKill';
import type { GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { isNodeActive, KILL_ARM_MS, KILL_MESSAGE_MS, KILLING_MAX_MS, STOP_ESCALATE_MS, type KillAction } from '@/modules/agent-monitor/graph/killability';
import type { AgentMonitorKillRequest, AgentMonitorKillResponse, AgentMonitorKillResult, AgentMonitorSession } from '@/shared/types';

/**
 * Where a box's kill button stands. `armed` = first press done, waiting for the second; `pending` = the request is out;
 * `waiting` = a stop was accepted and the agent has until `STOP_ESCALATE_MS` to end; `escalate` = it did not (or had no
 * handle), the button now offers the session kill; `escalateArmed` = that offer was pressed once; `killing` = done, waiting for
 * the snapshot to show it.
 */
export type KillStep = 'idle' | 'armed' | 'pending' | 'waiting' | 'escalate' | 'escalateArmed' | 'killing';
/** `force` = the agent was asked to stop and did not end; `session` = it had no handle to stop it with. Both end in the same session kill. */
export type KillEscalation = 'force' | 'session';

export type KillView = { step: KillStep; escalation: KillEscalation | null };
export type KillMessage = { result: AgentMonitorKillResult; count: number | null };

type KillFlow = {
  /** False outside a provider (no button is drawn at all). */
  enabled: boolean;
  view: (nodeId: string) => KillView;
  press: (node: GraphNode, action: KillAction) => void;
  message: KillMessage | null;
};

const IDLE: KillView = { step: 'idle', escalation: null };
const INERT: KillFlow = { enabled: false, view: () => IDLE, press: () => undefined, message: null };

const KillFlowContext = createContext<KillFlow>(INERT);
export const useKillFlow = (): KillFlow => useContext(KillFlowContext);

type Entry = KillView;
type KillSender = (request: AgentMonitorKillRequest) => Promise<AgentMonitorKillResponse>;

type KillFlowProviderProps = {
  /** The sessions of the snapshot on show: the picture a kill is judged against (is the box still working). */
  sessions: readonly AgentMonitorSession[];
  /** Replaced in tests. */
  send?: KillSender;
  children: ReactNode;
};

/**
 * The state of every kill button, held OUTSIDE React Flow: the flow is re-created when the set of sessions changes and a box
 * unmounts when it leaves the picture, and neither may lose a half-done confirmation, a running escalation timer or the
 * result line. Nothing here polls: the snapshot the pane already has says when a box stopped working.
 */
export function KillFlowProvider({ sessions, send = sendMonitorKill, children }: KillFlowProviderProps) {
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  const [message, setMessage] = useState<KillMessage | null>(null);
  const entriesRef = useRef(entries);
  const sessionsRef = useRef(sessions);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  const write = useCallback((next: ReadonlyMap<string, Entry>) => {
    entriesRef.current = next;
    if (mounted.current) setEntries(next);
  }, []);
  const setEntry = useCallback((nodeId: string, entry: Entry | null) => {
    const next = new Map(entriesRef.current);
    if (entry) next.set(nodeId, entry);
    else next.delete(nodeId);
    write(next);
  }, [write]);
  const clearTimer = useCallback((nodeId: string) => {
    const timer = timers.current.get(nodeId);
    if (timer) clearTimeout(timer);
    timers.current.delete(nodeId);
  }, []);
  const after = useCallback((nodeId: string, ms: number, action: () => void) => {
    clearTimer(nodeId);
    timers.current.set(nodeId, setTimeout(() => { timers.current.delete(nodeId); if (mounted.current) action(); }, ms));
  }, [clearTimer]);
  const settle = useCallback((nodeId: string) => { clearTimer(nodeId); setEntry(nodeId, null); }, [clearTimer, setEntry]);

  const say = useCallback((result: AgentMonitorKillResult, count?: number) => {
    if (messageTimer.current) clearTimeout(messageTimer.current);
    setMessage({ result, count: count ?? null });
    messageTimer.current = setTimeout(() => { if (mounted.current) setMessage(null); }, KILL_MESSAGE_MS);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const pending = timers.current;
    return () => {
      mounted.current = false;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      if (messageTimer.current) clearTimeout(messageTimer.current);
    };
  }, []);

  // A box that stopped working (or left the picture) ends its own "killing" / "waiting": the snapshot is the proof.
  useEffect(() => {
    for (const [nodeId, entry] of entriesRef.current) {
      if ((entry.step === 'killing' || entry.step === 'waiting') && !isNodeActive(sessions, nodeId)) settle(nodeId);
    }
  }, [sessions, settle]);

  const run = useCallback(async (node: GraphNode, mode: AgentMonitorKillRequest['mode'], escalation: KillEscalation | null) => {
    const startedAt = Date.now();
    setEntry(node.id, { step: 'pending', escalation });
    const response = await send({ sessionId: node.sessionId, nodeId: node.id, mode });
    if (!mounted.current) return;
    say(response.result, response.count);

    if (mode === 'stop' && response.result === 'stopped') {
      // The press is the start of the clock: the SDK's own answer time counts against the agent.
      setEntry(node.id, { step: 'waiting', escalation: null });
      after(node.id, Math.max(0, STOP_ESCALATE_MS - (Date.now() - startedAt)), () => {
        if (isNodeActive(sessionsRef.current, node.id)) setEntry(node.id, { step: 'escalate', escalation: 'force' });
        else settle(node.id);
      });
    } else if (mode === 'stop' && response.result === 'no-handle') {
      setEntry(node.id, { step: 'escalate', escalation: 'session' });
    } else if (response.result === 'killed' || response.result === 'gone') {
      setEntry(node.id, { step: 'killing', escalation });
      after(node.id, KILLING_MAX_MS, () => settle(node.id));
    } else {
      settle(node.id);
    }
  }, [after, say, send, setEntry, settle]);

  const press = useCallback((node: GraphNode, action: KillAction) => {
    const { step, escalation } = entriesRef.current.get(node.id) ?? IDLE;
    switch (step) {
      case 'idle':
        setEntry(node.id, { step: 'armed', escalation: null });
        after(node.id, KILL_ARM_MS, () => settle(node.id));
        break;
      case 'armed':
        clearTimer(node.id);
        void run(node, action.kind === 'agent' ? 'stop' : 'kill', null);
        break;
      case 'escalate':
        setEntry(node.id, { step: 'escalateArmed', escalation });
        after(node.id, KILL_ARM_MS, () => setEntry(node.id, { step: 'escalate', escalation }));
        break;
      case 'escalateArmed':
        clearTimer(node.id);
        void run(node, 'kill', escalation);
        break;
      default:
        // `pending`, `waiting` and `killing` take no press: a second request is exactly what must not happen.
        break;
    }
  }, [after, clearTimer, run, setEntry, settle]);

  const value = useMemo<KillFlow>(() => ({
    enabled: true,
    view: (nodeId) => entries.get(nodeId) ?? IDLE,
    press,
    message,
  }), [entries, press, message]);

  return <KillFlowContext.Provider value={value}>{children}</KillFlowContext.Provider>;
}
