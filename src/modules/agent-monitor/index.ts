// The sidebar's Running tab is the monitoring centre: the focus provider (shared state + the one snapshot poll), the tree pieces the
// sidebar renders under its project and session rows, and the main pane the workspace shows while the tab is on show.
export { RunningFocusProvider, useRunningFocus, useRunningMainPane } from '@/modules/agent-monitor/running/RunningFocusContext';
export { useRunningSessionClick } from '@/modules/agent-monitor/running/useRunningSessionClick';
export { RunningTreeScope } from '@/modules/agent-monitor/running/RunningTreeScope';
export { RunningSessionFrame } from '@/modules/agent-monitor/running/RunningTreeRows';
export { RunningTerminalProjects, RunningTerminalSessions } from '@/modules/agent-monitor/running/RunningTerminalRows';
export { RunningMonitorPane, type RunningActivityContext } from '@/modules/agent-monitor/running/RunningMonitorPane';
