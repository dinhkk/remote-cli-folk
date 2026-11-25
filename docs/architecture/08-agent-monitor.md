# The agent monitor

*A live, cross-project picture of which Claude sessions are running anywhere on the machine, which orchestrator is
delegating to which agents, what they cost in tokens, and how much CPU and memory the sessions use. It reads, and it has
one write: the **kill button** on a graph box (`POST /api/agent-monitor/kill`, see below).
Reached from the sidebar's Running tab (desktop and phone), not from Settings and not from a header icon.*

This document covers the `agent-monitor` module (server `server/modules/agent-monitor/`, client
`src/modules/agent-monitor/`) and the three core touch points that feed it. It assumes the run model of
[the realtime stream](./02-realtime-stream.md) and the orchestrated chats of [agent profiles](./07-agent-profiles.md).

---

## Mental model

Three sources, joined only in one response:

1. **Activity of app chats** (tree, state, tokens, timers): built from the events the server already emits for every run.
   No new provider call, no polling of Claude. Exact (`detail: 'live'`).
2. **Terminal sessions** (Claude started in a terminal or an editor, not by the app): derived from the CLI's own registry
   and the transcript files it writes (`detail: 'transcript'`). Approximate and may lag (a small `terminal` badge marks those rows).
3. **Resources** (CPU, memory): measured from the operating system's process table, **only while someone has a screen
   open**.

One request does the work:

| Request | Who polls | What it costs the server |
| --- | --- | --- |
| `GET /api/agent-monitor/snapshot` | the Running tab (one poll for the tree **and** the main pane), every 1 s while it is the open sidebar tab and the page is visible | everything: starts the CPU/RAM sampler and the transcript reading (both lease-gated, 8 s). |

`GET /api/agent-monitor/summary` (the cheap counts the removed header icon polled) is still served and still allowed for
Remote controllers, but **the client no longer calls it**. The snapshot request is both the data and the "somebody is
watching" signal; leaving the Running tab stops the polling, and the server's sampler and transcript reading lapse by
themselves.

```
 chatRunRegistry ──observer──▶ aggregator ──┐
 (every run event)            (tree, tokens) ├─▶ service.snapshot() ──▶ GET /snapshot ──▶ Running tab polls 1 s
 ~/.claude/sessions/<pid>.json ─▶ sampler ──┤      ▲ touch()                            (tree + overview + graph)
 (pid of each live session)    (CPU/RAM, lease)┤
 same registry + transcripts ─▶ terminal-sessions ┘ (tail reading, lease)
 registry only (peek) ─────────▶ service.summary() ──▶ GET /summary ──▶ (no client)
```

## Activity: the aggregator

`agent-monitor.aggregator.ts` is a pure in-memory reducer (clock and session-metadata reader injected, so it is
tested without a server). Fed by `chatRunRegistry.addObserver`, which `decorateAndRecordEvent` calls for every message
event and `startRun` calls for a run start. Observer errors are swallowed: the monitor can never break a chat.

| Event | Effect |
| --- | --- |
| `tool_use` of `Agent` / `Task` | A node keyed by the tool id. State `running`. |
| `task_status` `started` / `progress` / `updated` / `notification` | Tokens, tool-call count and duration from `usage` (the SDK sends it about every 0.4–3 s); `updated` / `notification` carry the final state. |
| `tool_use` with `parentToolUseId` | That node's "current tool" (`▸ Bash`). |
| `permission_request` | The node whose tool name matches turns `waiting` (the event has no parent id; attribution is by tool name). |
| `tool_result` of an agent tool | A background agent: only a "launched" receipt, ignored. A synchronous agent (no task events): its end. |
| `complete` / `error` | The orchestrator stops working; background agents keep running on after a normal end (their task events continue). An aborted `complete` stops every agent; an `error` marks the session failed. |

Rules worth knowing:
- A terminal state (`done`, `failed`, `stopped`) is never resurrected by a late event.
- Token deltas go into a ledger: tokens/min, tokens today and the sparkline come from it.
- Finished agents stay 90 s (at most 6 shown), then fold into a "+N finished" counter. An idle session leaves the view
  after 2 min and is dropped after 60 min (at most 20 sessions kept).
- Claude's `inputTokens` excludes cache. The cache-hit ratio (`cacheRead / (input + cacheRead + cacheCreation)`) is read
  from the token-usage service in the background, at most every 15 s per session.

## Resources: the sampler

`agent-monitor.sampler.ts` + `process-reader.ts` + `process-usage.ts`.

- **Lease-gated.** Every `snapshot()` calls `touch()`. The loop runs every 2 s while the lease (8 s) is alive and stops
  by itself when it lapses; its state is then dropped. Nothing runs with the screen closed (verified: no sampler child
  process in 20 s with the screen closed, 7 with it open).
- **No overlap, bounded.** A tick waits for the previous one; a read that takes more than 8 s is aborted (AbortController
  plus a race) and reported as the sample error.
- **Targets**: the server (own pid), each app session (the `claude` pid from `~/.claude/sessions/<pid>.json`, found through
  `listLiveClaudeCliProcesses`, mapped to an app session), and any other live Claude process as `external` (max 10; not in
  the headline total).
- **Per session = the process tree**: the `claude` process plus everything it started (tools, MCP servers).
  **There is no per-agent CPU or memory**: the agents of a session run inside one process, so the resource rows are per
  server and per session only (the screen has no note about it; it simply has no per-agent row).
- **CPU %** = Δ CPU seconds / Δ time / logical cores × 100 (Task Manager's scale, 100 % = the whole machine). The time
  is read inside the reader (`takenAt`), not before it starts, because PowerShell start-up takes hundreds of ms.
  A new child counts fully if plausible; a counter that goes backwards counts 0.
- **Memory** = sum of working sets (Task Manager's Details "Memory (active private working set)" is a different, smaller
  number; the working set matches `Get-Process`).
- **Reader**: Windows = one PowerShell call (CIM for parents + `Process.GetProcesses` for CPU/working set; the WMI perf
  classes were measured at ~42 s and are never used). macOS/Linux = `ps -eo pid=,ppid=,rss=,time=,comm=` (CPU time has
  1 s resolution there, so CPU % is coarser).
- **Child process groups** (`describeChildGroups`, read through `sampler.childGroups(pid)`): the descendants of a session's
  Claude process (the root excluded) grouped by process name: `{ name, count, rssBytes, cpuPercent }`, heaviest memory first,
  at most 8 groups; the rest are summed into one last group with an **empty name** (the client words it "other processes").
  It reuses the latest two samples the loop already took: no extra read, no timer, and empty when there is no sample
  (nobody watches). The pid comes from the sampler's session target (app chats) or the CLI registry (terminal sessions,
  `terminal.pidOf`); no pid, no groups. **Privacy: names, counts, memory and CPU only. Never a command line, argument, path
  or environment**: the process reader does not even collect them, and the snapshot is readable by Remote controllers.
- **Session usage** (`sampler.treeUsage(pid)` -> `AgentMonitorSession.usage`): CPU % (null until two samples), memory and
  process count of the **whole tree** under the Claude process (itself included), from the same two samples. **Three numbers,
  no pid and no top list** (unlike a resource row's `AgentMonitorUsage`). Absent when the pid is unknown or there is no sample;
  the client shows "—" then, never 0. Optional for older clients.
- History: ring of 1800 points per target (about 1 h at 2 s) for the sparklines.

## Terminal sessions

`agent-monitor.terminal-sessions.ts` + `agent-monitor.transcript-reader.ts` + `agent-monitor.projects.ts`. Everything is
in memory; nothing is stored.

- **Discovery**: the CLI's registry `~/.claude/sessions/<pid>.json` (pid, session id, folder, start time, entrypoint, name,
  status word `busy` / `idle`), kept only when the pid is alive. Any status word other than `busy` / `waiting` reads as
  idle: the monitor never claims work it cannot see.
- **Which entries are "terminal"**: those that are not already drawn from the app's own run events. A registry entry whose
  session id matches a chat the aggregator shows is a duplicate and is dropped, unless the aggregator shows it idle while
  the CLI says busy (the chat was resumed in a terminal). The result carries `source: 'app' | 'terminal'` and
  `detail: 'live' | 'transcript'`; the Running tab shows a small `terminal` badge on those rows (no explanatory note: the
  badge is the only marker).
- **Transcripts** (`~/.claude/projects/<folder with every non-alphanumeric → '-'>/<sessionId>.jsonl` and
  `<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json`), read **only while the Running tab is open** (lease 8 s, loop 2 s) and
  bounded: the last 128 KB of the main file, at most 1 MB of each sub-agent file, at most 30 sub-agents per session, at most
  400 project folders scanned when the folder-derived name misses, at most 500 cached files. Never the whole file.
- **Dedupe**: a transcript has one line per content block with the usage repeated, so tokens are counted once per message id.
- **Unknown stays unknown**: a sub-agent whose transcript has not grown for 3 minutes and never said it finished reads as
  `stopped`, not `running`; token counts are lower bounds (shown with `~`); a tool name appears only when the tail shows a
  call with no answer yet.
- **Deviation from the app's own data, on purpose**: a terminal *agent* is never `waiting` (the transcript does not say it
  waits for a permission answer) and never `failed` (a finished one reads as `done`), and its token rate is 0. Only the
  *session* can be `waiting`, from the registry's status word. A terminal session opens as a chat (`openSessionId`) once the
  app's own session index knows it; until then its row is shown, not tappable, and says why (seen live: tappable within
  seconds of the CLI starting, and it opened the chat).

`agent-monitor.projects.ts` groups every session by its folder (`projectKey` = normalised path, lower-cased for Windows
paths) into `AgentMonitorProject` rows: state `running` when it has a running session, `waiting` when only waiting ones,
else `idle`. A finished or idle session stays in the list for a short while (aggregator rules above), so a project is
"running" only by its sessions' state, never by recency.

## HTTP surface

The two `GET` routes and `POST /kill` are behind normal auth and answer `Cache-Control: no-store`. Types in `server/shared/types.ts` (mirrored in
`src/shared/types.ts`):

- `GET /api/agent-monitor/snapshot` → `AgentMonitorSnapshot`: `generatedAt` (the client uses it as a clock offset for the
  timers), `kpi` (with 60 s series), `sessions[]` (app and terminal sessions merged, busiest first, at most 40: orchestrator,
  agents, folded count, token and cache numbers, `source`, `detail`, `projectPath`, `projectKey`, `openSessionId`, `processes`: the child process groups above, empty when unknown; `usage`: the whole-tree CPU / memory / count above, optional),
  `projects[]` (the grouping above) and `resources` (`rows[]`, sampling flag, last sample time, error, core count). The
  by-agent token bars of the selection detail are derived on the client (`usage/agentTokenShares.ts`) from the session's agents;
  there is no by-project or by-model roll-up any more. `kpi.cpuPercent` / `kpi.rssBytes` are still sent but no screen reads them
  (the server's own numbers come from `resources.rows`): drop them in a later server change.
- `GET /api/agent-monitor/summary` → `AgentMonitorSummary` (`runningSessions`, `waitingSessions`, `runningProjects`): a cheap
  count that never touches the sampler or the transcripts. No client code calls it any more (the header icon was its only user).

- `POST /api/agent-monitor/kill` `{ sessionId, nodeId, mode: 'stop' | 'kill' }` → `{ result, count? }` (`AgentMonitorKillRequest` /
  `Result` / `Response`). `nodeId` is a graph node id: `orch:<sid>` (the main agent), `agent:<sid>:<agentId>`, `proc:<sid>:<name>`;
  the server parses it by the **exact prefix of the session id it was sent** (ids hold colons) and checks that the node is one of
  that session's own. **Result vocabulary** (one list, used by the server, the audit and the client's i18n):
  `killed` | `stopped` | `gone` | `no-handle` | `unavailable` | `refused` | `error`. HTTP: `refused` → 403, `error` → 500, all the
  others 200, so the Remote audit's result mirrors the status. **No process id** in the request, the response or the audit.

**Remote controllers can read both `GET` routes and press kill** (owner decisions: a phone paired as a Remote controller must
chat *and* monitor, and a Controller already has a Host shell, so a kill raises no privilege). They are exact `allow` rules in
`route-rules.ts` (`POST /kill` is audited as `host-write`, area `monitor`: node id, mode, session, HTTP status), mirrored in
`target-route-policy.ts` (`BLOCKED_PREFIXES` no longer lists `/api/agent-monitor`) and in the route inventory table; the Running
tab works in a Remote frame. Everything that edits configuration stays denied. **What this exposes**: the snapshot names the
Host's project folder paths, session labels and process names (the per-session process lists) to every paired Remote device,
and a Controller can end a Claude session or its child processes on the Host. A kill pressed on the Host itself does not go
through the bridge and is **not audited**.

## Kill (`agent-monitor.kill.ts`, `agent-monitor.process-kill.ts`)

What a box does when its kill button is confirmed:

| Box | Server does |
| --- | --- |
| process group | kills the descendants of the session's `claude` whose process name belongs to the group (never the root, never a protected pid) |
| main agent (`orch:`) | kills the session's whole `claude` tree, then quiets the run (below) |
| sub-agent, `mode: 'stop'` | asks the SDK to stop that one task (`stopTask`, 3 s timeout); no handle or no answer → `no-handle` |
| sub-agent, `mode: 'kill'` | the session kill, same as the main agent |
| `session:` / "+N finished" / "other processes" | nothing: the client has no button and the server refuses the shape |

Safety, because the request is not trusted:

- **The pid is found at kill time**, from the CLI registry (`listLiveClaudeCliProcesses`, by the session) and a **fresh** process
  table read. Never the sampler's or the terminal reader's cache (it can be seconds old and lease-bound).
- **The root is verified** before anything dies: its image name must be `claude` on Windows (`claude`, `node` or `bun` on POSIX)
  and its start time within 10 s of the registry's `startedAt`. A reused pid fails this and the answer is `gone`.
- **Protected set**: the server, everything above it, and the whole tree of every *other* Claude root. A tree that holds the
  server or another registry root is `refused`. The target's own subtree is taken out of the protected set, because an app chat's
  `claude` is a child of the server. A descendant that appears to start before its parent (a reused parent pid) is not a child.
  At most 64 pids per kill.
- **The outcome is read, not assumed**: after the kill the table is read again. `taskkill` answers 128 both for "already gone"
  and "access denied" (measured), so its exit code is never used.
- **Single flight** per session: two presses at once run one kill.
- **Terminal sessions** (`terminal:` ids, started in a CLI the app does not own): `orch:` and `proc:` can be killed (by pid); an
  `agent:` node is `refused` (there is no SDK handle) and the client draws no button there. Only the `claude` provider.

After a kill that ends a session's process the **run loop is quiet**: the runtime marks the session (`markClaudeSessionKilled`)
before the kill so the dying process is not reported as a failed run, pending permission approvals are cancelled (they would
be replayed by `chat.subscribe`), the chat run ends as `{ exitCode: 0, aborted: true }`, and `aggregator.settleSession` stops every
agent, so the next snapshot shows the session `idle` and no node `running`. The mark is taken back if the kill failed, or after
10 s, so it cannot swallow the next run's end.

## Client

The monitor is the **Running tab of the sidebar**. There is no header icon, drawer, full view or list/graph switch any
more (all removed, with the Settings tab before them).

- **Left: the tree** (`running/buildRunningTree.ts` pure model, `RunningTreeScope` provider, `RunningTreeRows`,
  `RunningTerminalRows`). It extends the existing `SidebarProjectList`: Project → Session → **Main agent** → its
  sub-agents and process groups as **siblings** (plus a "+N finished" line). The session row is still the usual
  `SidebarSessionItem` with its own actions; `RunningSessionFrame` only adds the tree under it, and is inert outside the
  Running tab. Terminal sessions join the project row of the same folder (`folderKey`: case-folded for Windows paths,
  slashes and trailing slash normalised) with a small "terminal" badge, else get a project row of their own named after the
  app project with that folder, else after the folder. A terminal session the app already has a chat for (`openSessionId`)
  is that chat's own node, not a second row; idle terminal sessions are left out unless focused. State dots come from
  `STATE_DOT` in `graph/stateStyle.ts` (same palette as the graph). Expansion is per node: a session that is not idle
  opens to its main agent, the main agent opens only while it works and has children; the user's own opening/closing wins,
  and a graph-driven focus opens the ancestors so the focused row is visible. Process rows show **name, count and memory
  only**.
- **Right: the main pane** (`RunningMonitorPane`, mounted by `WorkspaceMain` only while the Running tab is open; the
  workspace stays mounted underneath, `hidden`, so a chat keeps its state). Nothing focused → **overview** (KPI strip,
  graph of every running session, and the machine card). A session, main agent, sub-agent or process focused → the
  single-session graph (filling the pane) with that box ringed (`data-node-focused`, `aria-pressed`) and its numbers in the
  rail (the machine card is replaced by them). **No click on a node opens a chat**: a session row or box only focuses the session (`toggleSession` with no chat id;
  `useRunningSessionClick` looks the session up in the snapshot, since a terminal session the app has a chat for is keyed by
  its terminal id). The chat is reached from the Projects tab or from the Activity's "view in chat". With a chat already open
  on the route, a focus covers it with the graph and releasing the focus shows the chat again.
  The overview is a tidy column and nothing else: header summary line, KPI strip (agents, tokens per minute, tokens today:
  no CPU or memory), graph card and the machine card. The screens carry **no explanatory or how-to text** (no legend, graph hint, token or limits note, derived-note): only titles,
  numbers, state labels and the notices that signal a real problem (unreachable API, stale picture, failed measurement, a
  CPU or memory warning). Aria labels are not visible and stay.
- **The rail: machine card OR selection detail** (`running/MonitorRail`). Beside or under the graph, exactly one card: with
  nothing focused (all sessions) the **machine card** (`usage/MachineCard`: CPU % and used / total memory of the WHOLE host,
  from `resources.machine`, read by `server/.../agent-monitor.machine-usage.ts` from `os.cpus()` / `os.totalmem()` /
  `os.freemem()`; CPU is the busy share of all cores between two readings, null until the second, one reading per second at
  most), and with a box focused the **selection detail** (`usage/SelectionDetail`) of that session or node. `running/resolveSelection` maps the
  focused node id (`session:` / `orch:` / `agent:` / `proc:` / `folded:`) to what to show: a session or its main agent shows
  the session's whole-tree `usage` plus the by-agent token bars (`usage/TokenBars`, `agentTokenShares`); a sub-agent its own
  state, elapsed, tokens and tool calls; a process group its count, memory and CPU. With nothing focused no session's CPU,
  memory or tokens are on screen. The detail is a summary: the sub-agent's timeline stays in Activity.
- **Chips on the boxes** (`graph/NodeStat`): a session box shows elapsed and its tree's CPU / memory, the main agent elapsed,
  context size and its last tool, a sub-agent elapsed, tokens and tool calls, a process group count, memory and CPU. Each chip
  is `role="img"` with an `aria-label` / `title` (no visible words); a value that is not known yet (no second CPU sample,
  no `usage`) has **no chip**, never a zero or a dash.
- **Layout by the pane's own width** (`hooks/useElementWidth`, `widthTier`): the sidebar takes a variable share of the
  window, so the tier is measured on the pane, not the viewport (ResizeObserver, debounced 150 ms, measured before the first
  paint). `narrow` < 640 px, `medium` 640-999, `wide` >= 1000; an unknown width (0, no layout engine) reads as `wide`. The
  pane carries `data-tier`, and `running/MonitorColumns` places the rail: `wide` = beside the graph (`side-by-side`),
  `medium` = under it (`rail-below`), `narrow` =
  **above** it (`rail-above`: the detail of a tapped box is seen without scrolling past the graph). The KPI strip keeps its
  three cards in every tier, smaller when `narrow`. The graph frame is `clamp(320px, 55vh, 600px)` high in the overview, the
  pane's remaining height in the single-session view.
- **The graph is fitted again when its frame changes size** (`graph/FitOnResize`, `graph/useRefitOnResize`): the frame's
  size is watched (a ResizeObserver on the frame the marker sits in, since this `@xyflow/react` build exposes no `useStore`),
  and a change fits the view after 150 ms, **unless the user panned or zoomed since the last fit** (`moved`, set by
  `onMoveStart` with a real event, cleared by the Fit button, a reset, or a new set of sessions). The first size is not a
  change, a tick never refits. **Turning the child process boxes on or off also starts a fresh, fitted flow** (part of the
  flow key in `MonitorGraph`): fitted without them, the view would leave them past the frame's edge (on a phone the process
  boxes and their kill button were out of reach until the graph was panned).
- **Activity** (a sub-agent's recorded work: prompt, each tool call with output/diff, stop, view in chat). It replaces the
  workspace's former "Agents" tab, whose tree duplicated this one. With a sub-agent box focused (`mainPane === 'graph'`),
  `RunningMonitorPane` draws a slot **under the graph** on a `medium` / `wide` pane. On a `narrow` pane it is its own view: the
  sub-agent's detail card (above the graph) gets an **Activity** button (`MonitorRail` / `SelectionDetail` `onOpenActivity`) that
  swaps the pane's content for the Activity alone, filling the height (`RunningActivityContext.fill`), with a **Back** button
  (44 px). The pane keeps `activityOpenFor` (`<session>|<agent>`): any other focus, or no Activity target, closes it by itself;
  Back and opening never change the focus (the graph remounts, the kill state lives outside it). `activityTarget` (`running/activityTarget.ts`) decides whether
  there is one: only `agent:<sid>:<id>` nodes of a session that has a chat (`openableChatId`), never a terminal-only
  session, a workflow or a process leaf. `agent-monitor` does not import `chat` or `project-workspace`: `WorkspaceMain`
  supplies the content through the `renderActivity` prop (`AgentActivityPanel`, which wraps the former
  `SubagentDetailView`). The monitor's node id is the tool_use id, so `resolveActivityNode` matches the chat message by
  `message.toolId` (or `message.subagent.id`, the agent id) in `buildAgentTree`'s root children. Messages come from
  `useActivityMessages`: the open chat is already live in the session store; a chat that is not open is fetched once
  (`fetchFromServer`), then re-read (`refreshLatestFromServer`) every 3 s while the agent works (not while the page is
  hidden), and once more when it stops. "View in chat" releases the pane (`toggleSession`), shows the chat tab and
  `scrollToToolResult` looks for `#tool-result-<toolId>` for a few seconds while the chat mounts. Files open in the editor
  only for the chat that is open (the editor belongs to its project).
- **Focus** (`RunningFocusContext`): a React context mounted around the workspace by `RunningFocusBoundary`. Two
  contexts on purpose: focus state (low frequency) and the snapshot (1 s). `explicit` holds a node focus or a terminal
  session without a chat; a focused **app chat is derived from the route** (`routeSessionId`), so a refresh, a deep link
  or a chat opened from inside the tab (the Activity's "view in chat") stays on show. **Turning the tab on (off -> on only)
  leaves an open chat for `/`** (`leaveChat`), so the overview is shown at once, with nothing clicked; a sidebar remount at the
  breakpoint is not an off -> on change. `mainPane = !runningActive ? null : explicit ? 'graph' : route ? null : 'overview'`. Clicking a focused row un-focuses it. Leaving the tab, a route
  change or the session leaving the snapshot clears the explicit focus. Clicking a graph box focuses the same row. On a phone
  every focus change closes the sidebar drawer (`onFocusChosen`). **`runningActive` survives a rebuilt sidebar**: the
  sidebar is mounted in two places (desktop column, phone drawer), so crossing the phone breakpoint unmounts one and mounts the
  other; the provider keeps `runningActive` (the sidebar sets it from its tab and does not clear it on unmount) and the new
  sidebar opens on the Running tab (`initialSearchMode`), so a resize keeps the monitor and its focus instead of dropping to
  the Projects tab. Clicking a project row in the
  Running tab does not navigate, and starting a new session there switches back to the Projects tab so the new chat is not
  hidden behind the overview.
- **One poll**: the provider owns the only `useAgentMonitor(runningActive && pageVisible)`; the tree and the pane read
  the same snapshot. Without a provider (tests of other components) both contexts are inert.
- **Phone**: every row is a button of at least 44 px (`min-h-[44px] md:min-h-[32px]`), expand toggles are 44 px with
  `aria-expanded`, rows carry `aria-pressed`, the graph is a fixed-size box you pan and pinch-zoom inside (its zoom
  buttons are 44 px on a coarse pointer), nothing scrolls the page sideways, and motion follows reduced-motion. One
  consequence of touch panning: a finger that starts on the graph pans it instead of scrolling the page, so the page
  scrolls from the margins and the cards around the graph.
- **No answer ≠ nothing running**: `readMonitorJson` reads the body as text, and anything that is not the monitor's JSON
  (a dev proxy answering `index.html`, an outdated server without the route or without `projects`) becomes a
  `MonitorApiError('unreachable')`. The tree and the pane then show "cannot reach the monitor API, the server may be
  outdated" with a retry button, and only a real empty snapshot shows "nothing is running".
- **Graph** = [React Flow](https://reactflow.dev) (`@xyflow/react` 13), loaded lazily (`graph/MonitorGraphLazy.tsx`:
  `React.lazy` + `Suspense`, a quiet placeholder of the graph's size meanwhile) so it is not in the first bundle; its
  stylesheet and `graph/monitorFlow.css` load with it. An empty snapshot draws no graph and never loads the library.
  - **Shape**: `layoutMonitorTree` stays the pure left-to-right layout, **one tree per session** (no server box): the
    session is the root, then its orchestrator, then the leaves in one column: agents, the "+N finished" fold, and one
    **process leaf** per child process group (grey, dashed, chip glyph, `×count`, memory, CPU; reads `running` while the
    session works, else `done`). Caps: 36 agents overall, at most 5 process groups per session and 30 overall; what is
    left out is counted in a short line under the graph. It supplies only the INITIAL position and the fixed size of each
    box. `buildFlowGraph.ts` turns the layout into React Flow nodes and edges (same ids, `type` = the layout kind,
    declared connector dots so edges can be placed before any measuring).
  - **Interaction**: boxes can be **dragged**; the view pans (drag the background) and zooms (pinch, the +/- buttons,
    Ctrl/Cmd + wheel; a plain wheel scrolls the page, since the overview graph sits in a scrolling column). Nothing can be
    connected, deleted or selected by hand (`nodesConnectable={false}`, `deleteKeyCode={null}`, `elementsSelectable={false}`).
    Controls: zoom in/out, fit, and **reset layout** (drops every dragged position and refits). No minimap. The default
    React Flow attribution stays (bottom-right).
  - **Positions survive refreshes**: a snapshot arrives every second. `nodePositions.ts` (pure) keeps the dragged
    position per node id in component state: a dragged box keeps it, a **new** box takes the layout position, a box that
    left the picture **forgets** its position. The view is fitted only on first render and when the **set of shown
    sessions** changes (the flow is keyed by the sorted session ids, so a reorder alone is not a change); a tick never
    re-fits and never touches pan or zoom. `useDragClickGuard` makes a drag not count as a click.
  - **Boxes**: custom node types (`session`, `orchestrator`, `agent`, `folded`, `process`; `nodeTypes` / `edgeTypes` are
    module-level constants). Each is a button (`aria-pressed`, `aria-label`, Tab, Enter/Space) that reports a click as
    before: every box (the session box too) focuses the same row in the tree and shows its numbers, a second click releases; the
    focused box gets a ring (`FocusRing`, `data-focus-ring`). The timers, clock and focus reach the boxes through
    `monitorFlowEnv` (a context), not through node data.
  - **Edges**: width ~ log(tokens/s) (`edgeThickness`; a process edge is thin); coloured by the child's state while it
    works, quiet grey otherwise; a working edge flows (dashes) unless motion is off; a process edge flows only while its
    group uses at least 1 % CPU. Edges are `aria-hidden`: the boxes carry the information.
  - **Theme**: the colours come from the app's own tokens (`--card`, `--border`, ... which the `dark` class on `<html>`
    switches), set as `--xy-*` variables in `monitorFlow.css`; the graph, its controls and the attribution follow the
    app theme, not the operating system's.
- **Child processes are hidden until asked for.** One switch (`graph/ProcessToggle`, an icon button in the graph card header,
  `aria-pressed`) drives both the graph boxes and the process rows of the tree. The choice lives in
  `RunningFocusContext` (`showProcesses`, from `hooks/useShowProcesses`, kept in `localStorage['agentMonitor.showProcesses']`,
  hidden when storage is blocked). Hiding it drops a focus on a `proc:` node. The pure builders default to showing
  (`layoutMonitorTree` 4th argument `{ showProcesses }`, `buildRunningTree` input), so only the provider decides the UI default;
  outside a provider they are drawn. A process leaf can therefore only be inspected or acted on after the switch is on.
- **Kill button** (`graph/KillButton`, `KillFlowContext`, `killability.ts`, `KillMessage`). Drawn only on the **focused** box, so
  only in the single-session graph (the overview focuses nothing), and only when `killAction(node)` says the box can be killed:
  the main agent, a working sub-agent (not of a `terminal:` session) and a **named** process group of a working session. Never on
  a session box, the "+N finished" fold or the "other processes" group. It is a **sibling** of the box's own `role="button"`
  (never nested), `nodrag nopan`, and stops click / pointer / key events so pressing it neither selects nor drags the box; on a
  coarse pointer it is 44 px. Two steps: the first press arms it for 3 s ("Stop agent?", "Kill whole session?", "Kill 3 node
  processes?"), the second sends. A sub-agent sends `mode: 'stop'`; if its node still works 5 s **after the press** the button
  becomes "Force kill session" (two steps again, `mode: 'kill'`), and a `no-handle` answer goes straight to "Kill session".
  After a send the box reads "Killing…" until the next snapshot shows it changed or 8 s pass. The state lives in `KillFlowProvider`
  (around the pane, **outside** React Flow) so a remount of the graph (a changed set of sessions) keeps an armed button and its
  timers; the result line (one sentence per result word) is in the pane's `aria-live` region, so it outlives a box that
  disappears. A process group can only be killed once the child-process switch above is on.
- **Motion** all under `.monitor-anim` (`src/index.css` for the keyframes of the boxes, `monitorFlow.css` for the edge
  dashes): spinner and pulse on working boxes, flowing dashes on working edges, a shake on failure. **Reduced motion**
  (`prefers-reduced-motion`, followed live) and a hidden tab remove the class / pause: the picture is the same, drawn
  still, state carried by colour and glyph. (`monitor-flow`, `monitor-burst` and `.monitor-node` in `index.css` belong to
  the former hand-drawn SVG graph and are unused now.)
- Hooks: `useAgentMonitor` (1 s poll, no overlap, keeps the last snapshot on error; the in-flight guard is local to each
  polling loop so a restarted loop is never blocked by an abandoned request), `usePageVisible`, `usePrefersReducedMotion`, `useServerNow`
  (server-clock timers), `useAnimatedNumber`.
- The Settings → Agent Monitor tab no longer exists (tab lists, i18n key and tests removed).

## Gotchas

- **Resources need a watcher.** With the Running tab closed there is no CPU/RAM data and no history; the sparklines start
  when it opens. The same holds for terminal transcript reading. The tab's badge counts app sessions only (from the app's own
  session state), so it works without the monitor poll.
- **Activity is per chat, and lossy by design.** No Activity for terminal-only sessions or Remote. A chat's history is
  read from the server on demand, so a very fresh sub-agent can show "No recorded activity" for a moment. The workspace
  "Agents" tab is gone with its Root (whole-session) inspector and the running-tasks badge on the tab; the sidebar Running
  tab's session count stays the signal. A workflow or a background Bash only has Activity when its `toolId` matches the
  monitor node id.
- **A terminal session is a reading of files, not a stream.** It can lag a few seconds behind the CLI, it can be missing
  when the CLI's registry or transcript layout changes, and a session started under another user account is not seen.
- **Counts are of sessions, not agents.** The Running tab badge reads 2 while the tree lists 5 agents; terminal sessions are not
  in the badge or in a project row's own session count.
- **The harness that polls must not block.** A blocking call that stops the polling ends the lease and the sampler
  (this cost an evaluation run once).
- **CPU% of a short-lived child** can be under- or over-stated by one interval; the sum for a tree is steady.
- **Working set vs private working set.** The monitor reports the working set (matches `Get-Process`); Task Manager's
  default column is smaller (measured +35 % on a Node + shell tree).
- **A permission prompt is attributed by tool name**, so two agents waiting on the same tool at once can swap.
- **The aggregator is memory only.** A server restart empties it until the next run event; a run already in progress
  is not reconstructed.
- **Session `usage` can be missing.** No pid or no sample (nobody watching yet, a terminal session whose pid is unknown): the
  session box has no CPU or memory chip and the detail shows a dash, which is not the same as 0. (`kpi.cpuSeries` /
  `kpi.rssSeries`, are still the server process's series; no card draws them now, the machine card shows the current
  values of the whole host.) A server that predates `resources.machine` sends none: the client must not read it then.
- **No roll-up by project or model.** The old usage panel's by-project and by-model bars are gone with it; only the by-agent
  shares of one session remain. If that view is wanted back it needs its own card, not the rail.
- **Below the wide tier the single-session pane scrolls.** The graph frame keeps its least height (320 px) and the rail sits
  under (medium) or over (narrow) it, so on a short window the column is taller than the pane; a fixed pane height made the rail
  print over the graph (`monitor-root` is `h-full` only when wide, else `min-h-full`; neither the columns nor the graph card
  carry `min-h-0`).
- **Narrow panes draw the graph small.** The horizontal layout is about 528 px wide, so on a 360 px phone the fitted view is
  roughly 0.65 zoom; boxes are readable by pinch. A vertical tree for `narrow` panes was designed and not built (see the
  plan's phase 6): build it only if the live check shows the small zoom is a problem.
- **Kill ends a session, not an agent, unless the SDK knows the task.** `stopTask` covers an agent the SDK has a handle for within
  3 s; any other agent needs the session kill, which also ends its siblings. After it the session is `idle` and its agents `stopped`.
- **Kill: what was not measured.** POSIX process names and kill (`claude|node|bun`, `ps`) are coded to the same rules but were only
  exercised through injected readers, not on macOS or Linux. A kill pressed on the Host itself is not audited (only the bridge is).
- **Locales.** Only `en/agentMonitor.json` exists; other locales fall back to English.

## Coupling

| If you change… | …also check |
| --- | --- |
| the monitor's agent node id, or `buildAgentTree` / the `toolId` of chat messages | `resolveActivityNode`, `activityTarget`, their tests |
| `task_status` normalisation (`readTaskStatusEvent`) | the aggregator (`usage`, `taskId`, `toolUseId`), its tests |
| `chatRunRegistry` event recording | the observer call sites, `chat-run-registry.test.ts` |
| `~/.claude/sessions/<pid>.json` handling (`claude-cli-liveness.service.ts`) | `listLiveClaudeCliProcesses`, the sampler targets, the busy-session list |
| `AgentMonitorSnapshot` / `AgentMonitorSummary` shape | both `types.ts` files, `isMonitorSnapshot` in `readMonitorJson.ts`, the fixtures in `src/modules/agent-monitor/tests/`, `buildRunningTree`, the tree rows and the pane |
| The Remote allow rules for `snapshot` / `summary` | `route-rules.ts`, `target-route-policy.ts`, the remote inventory table; the snapshot exposes Host folders and process names to paired devices |
| The CLI registry or transcript layout (`~/.claude/sessions`, `~/.claude/projects/**/subagents`) | `agent-monitor.terminal-sessions.ts`, `agent-monitor.transcript-reader.ts` and their fixtures |
| The graph node ids (`sessionNodeId` / `orchestratorNodeId` / `agentNodeId` / process id) | `buildRunningTree` row keys, the focus context, the tree rows: a focus finds its graph box and its row by the same key |
| The Running tab's focus rules or `WorkspaceMain` pane | `runningTabTree.test.tsx`, `runningMonitorPane.test.tsx`, `RunningFocusBoundary` (drawer close, session release) |
| Sampler timings (lease / interval / timeout) | `MONITOR_POLL_MS` (the poll must be shorter than the lease), the sampler tests |
| `AgentMonitorProcessGroup` / `describeChildGroups` | the privacy rule (name, count, memory, CPU only), `layoutMonitorTree`'s process caps, both `types.ts` files, the `process-usage` / `sampler` / `service` tests |
| Motion rules in `index.css` / `monitorFlow.css` | the reduced-motion fallback (`.monitor-anim` gate) and the pane and graph tests |
| `@xyflow/react` (version bump) | `graph/monitorFlow.css` (`--xy-*` variable names, class names), `buildFlowGraph.ts` (`handles`, node/edge fields), `MonitorGraph.tsx` (props, `onNodesChange` signature), the jsdom stand-ins in `vitest.setup.ts`, `monitorGraph.test.tsx` |
| Node sizes or the layout columns in `layoutMonitorTree` | `buildFlowGraph.ts` (connector positions come from the box size), the card and process node components |
| `layoutMonitorTree` options (`showProcesses`) or `buildRunningTree`'s `showProcesses` | `RunningFocusContext` (the one switch), `MonitorGraph` / `MonitorGraphCard`, `processVisibility.test.tsx`: the graph and the tree must agree on what is hidden |
| The graph node id grammar (`session:` / `orch:` / `agent:` / `proc:` / `folded:`) | `resolveSelection`, `selectionDetail.test.tsx`, the node chips, **and the kill route's id parser** (`agent-monitor.kill.ts`) |
| The kill result words (`killed` … `error`) | `AgentMonitorKillResult` in both `types.ts`, the route's HTTP map, the Remote audit's `result`, `graph.kill.result.*` in `agentMonitor.json`, `agentMonitorTranslations.test.ts` |
| `groupKeyOf` (process group names) | the sampler's groups **and** the kill's group selection: the box the user sees and the processes killed must be the same set |
| `POST /kill` allow rule, `bridge-write-audit.ts` | `route-rules.ts`, the inventory table (`EXPECTED_INVENTORY_ROWS`, `registrations`), `bridge-write-audit-monitor.test.ts` |
| `MEDIUM_FROM` / `WIDE_FROM` in `useElementWidth` | `MonitorColumns`, `MonitorOverview` (KPI `compact`), `monitorTierLayout.test.tsx` |
| `AgentMonitorSessionUsage` / `sampler.treeUsage` | both `types.ts` files, `withProcesses` in the service, the session chips and `SelectionDetail` |
| Any text on the monitor screens | keep it to titles, numbers, state labels and real-problem notices (see Client); `agentMonitorTranslations.test.ts` fails on a missing key and on the removed notes coming back |
