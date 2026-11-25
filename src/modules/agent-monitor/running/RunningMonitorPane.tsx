import { ArrowLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { KillFlowProvider } from '@/modules/agent-monitor/graph/KillFlowContext';
import { KillMessage } from '@/modules/agent-monitor/graph/KillMessage';
import { MonitorGraphCard } from '@/modules/agent-monitor/graph/MonitorGraphCard';
import { sessionNodeId } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { useElementWidth, widthTier } from '@/modules/agent-monitor/hooks/useElementWidth';
import { useServerNow } from '@/modules/agent-monitor/hooks/useServerNow';
import { MonitorOverview } from '@/modules/agent-monitor/overview/MonitorOverview';
import { MonitorColumns } from '@/modules/agent-monitor/running/MonitorColumns';
import { MonitorErrorNotice } from '@/modules/agent-monitor/running/MonitorErrorNotice';
import { MonitorRail } from '@/modules/agent-monitor/running/MonitorRail';
import { activityTarget, type ActivityTarget } from '@/modules/agent-monitor/running/activityTarget';
import { useEffectiveRunningFocus, useRunningFocus, useRunningMonitorData } from '@/modules/agent-monitor/running/RunningFocusContext';

/**
 * What the workspace's `renderActivity` is handed: the sub-agent to show, a way to open its chat (which leaves the pane), and
 * whether it is drawn as the pane's whole view (a narrow pane: it should then fill the height) or as a section under the graph.
 */
export type RunningActivityContext = ActivityTarget & { openChat: () => void; fill: boolean };

type RunningMonitorPaneProps = {
  /** Put before the title: on a phone the workspace passes its "open the sidebar" button, which is the way back to the list. */
  leading?: ReactNode;
  /**
   * Draws the Activity (the sub-agent's recorded tool calls and outputs) under the graph while a sub-agent box is focused. The
   * monitor has no transcripts, so the workspace, which owns the chat messages, supplies it; without it no section is drawn.
   */
  renderActivity?: (context: RunningActivityContext) => ReactNode;
};

/**
 * The main area while the sidebar's Running tab is on show and the route's own view is not wanted: the OVERVIEW (KPI
 * strip, the graph of every running session, usage and resources) while nothing is focused, or the GRAPH of one session
 * with the focused node ringed (a main agent, a sub-agent, a process group, or a terminal session that has no chat).
 * It draws the snapshot the focus provider polls; it starts no poll of its own.
 */
export function RunningMonitorPane({ leading, renderActivity }: RunningMonitorPaneProps) {
  const { t } = useTranslation('agentMonitor');
  const { mainPane, toggleNode, toggleSession } = useRunningFocus();
  const focus = useEffectiveRunningFocus();
  const { snapshot, status, clockOffsetMs, errorKind, errorMessage, retry, visible, animate } = useRunningMonitorData();
  const now = useServerNow(clockOffsetMs, visible);
  // The layout follows the pane's own width: the sidebar takes a variable share of the window.
  const { ref: paneRef, width: paneWidth } = useElementWidth<HTMLDivElement>();
  const tier = widthTier(paneWidth);

  // A click on a box only focuses it (a second click lets go): the session box included, which shows the session's numbers.
  // Opening the chat is the Activity's "view in chat", not a click on a box.
  const onSelectNode = (sessionId: string, nodeId: string | null) => {
    if (nodeId) toggleNode(sessionId, nodeId);
    else toggleSession({ sessionKey: sessionId, chatId: null });
  };

  const focusedSession = mainPane === 'graph' && snapshot ? snapshot.sessions.find((session) => session.id === focus?.sessionKey) : undefined;
  const activity = renderActivity && mainPane === 'graph' && snapshot ? activityTarget(snapshot.sessions, focus) : null;
  // Under the graph on a medium or wide pane. On a narrow one the detail card above the graph has an "Activity" button that
  // swaps the pane for the Activity alone, with a Back button. `activityOpenFor` names the sub-agent it was opened for, so
  // any other focus (or no Activity at all) closes it by itself; the focus is never touched by opening or closing it.
  const [activityOpenFor, setActivityOpenFor] = useState<string | null>(null);
  const narrow = tier === 'narrow';
  const activityKey = activity ? `${activity.sessionKey}|${activity.agentId}` : null;
  if (activityOpenFor !== null && activityOpenFor !== activityKey) setActivityOpenFor(null);
  const activityView = narrow && activity !== null && activityOpenFor === activityKey;
  const openActivityChat = activity ? () => toggleSession({ sessionKey: activity.sessionKey, chatId: activity.chatId }) : undefined;
  const title = focusedSession ? t('pane.graphTitle', { name: focusedSession.label }) : t('pane.overviewTitle');
  // The single-session graph fills the pane; the overview is a column of cards that scrolls.
  const fillPane = mainPane === 'graph';

  return (
    <div ref={paneRef} className="flex h-full min-w-0 flex-col overflow-x-hidden bg-background" data-testid="running-pane" data-pane={mainPane ?? 'none'} data-tier={tier}>
      <header className="pwa-header-safe flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur-sm sm:px-4">
        {leading}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" data-testid="running-pane-title">{title}</h2>
        {snapshot && (
          <p className="shrink-0 text-xs text-muted-foreground" data-testid="running-pane-summary">
            {t('pane.summary', { sessions: snapshot.kpi.runningSessions, agents: snapshot.kpi.runningAgents })}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:px-4">
        {!snapshot && (status === 'error'
          ? <MonitorErrorNotice kind={errorKind} message={errorMessage} onRetry={retry} />
          : <p className="text-sm text-muted-foreground" data-testid="monitor-loading">{t('state.loading')}</p>)}

        {snapshot && (
          // The kill buttons' state lives here, above the graph: React Flow remounts the boxes, this does not.
          <KillFlowProvider sessions={snapshot.sessions}>
          {/* `monitor-anim` switches every keyframe on; without it (reduced motion, hidden tab) the picture is the same, drawn still. */}
          <div
            // The single-session view is as tall as the pane on a wide one (the rail scrolls by itself beside the graph); below
            // that the graph keeps its own least height and the rail sits under or over it, so the column may be taller than
            // the pane and the pane scrolls: a fixed height would let the rail print over the graph.
            className={`monitor-root ${fillPane ? `flex flex-col gap-3 ${tier === 'wide' ? 'h-full' : 'min-h-full'}` : 'space-y-3'} ${animate ? 'monitor-anim' : ''}`}
            data-motion={animate ? 'on' : 'off'}
            data-paused={visible ? 'false' : 'true'}
            data-testid="agent-monitor"
          >
            {status === 'error' && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="monitor-stale">
                <span className="min-w-0 flex-1">{errorKind === 'unreachable' ? t('state.unreachable') : t('state.stale', { message: errorMessage ?? '' })}</span>
                <button type="button" onClick={retry} className="min-h-[44px] rounded border border-border px-3 hover:bg-accent">{t('state.retry')}</button>
              </div>
            )}

            <KillMessage />

            {activityView && activity && renderActivity && openActivityChat
              ? (
                <>
                  <button
                    type="button"
                    onClick={() => setActivityOpenFor(null)}
                    className="inline-flex min-h-[44px] shrink-0 items-center gap-2 self-start rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent"
                    data-testid="activity-back"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    {t('agentActivity.back')}
                  </button>
                  <section className="min-h-0 flex-1" aria-label={t('agentActivity.title')} data-testid="running-activity" data-activity-view="full">
                    {renderActivity({ ...activity, openChat: openActivityChat, fill: true })}
                  </section>
                </>
              )
              : (
                <>
                  {mainPane === 'graph'
                    ? (focusedSession
                      ? (
                        <MonitorColumns
                          tier={tier}
                          fill
                          main={<MonitorGraphCard sessions={[focusedSession]} now={now} animate={animate} highlightId={focus?.nodeKey ?? sessionNodeId(focusedSession.id)} onSelectNode={onSelectNode} fill />}
                          rail={<MonitorRail snapshot={snapshot} now={now} focus={focus} onOpenActivity={narrow && activity ? () => setActivityOpenFor(activityKey) : undefined} />}
                        />
                      )
                      : <p className="text-sm text-muted-foreground" data-testid="running-session-gone">{t('pane.sessionGone')}</p>)
                    : <MonitorOverview snapshot={snapshot} now={now} animate={animate} tier={tier} onSelectNode={onSelectNode} />}

                  {activity && renderActivity && openActivityChat && !narrow && (
                    <section className="shrink-0" aria-label={t('agentActivity.title')} data-testid="running-activity">
                      {renderActivity({ ...activity, openChat: openActivityChat, fill: false })}
                    </section>
                  )}
                </>
              )}
          </div>
          </KillFlowProvider>
        )}
      </div>
    </div>
  );
}
