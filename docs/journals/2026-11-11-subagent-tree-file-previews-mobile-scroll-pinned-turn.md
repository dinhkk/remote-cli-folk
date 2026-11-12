# Technical Journal: Subagent Workspace View, Inline File Previews, Mobile Scroll Stabilization & Dynamic Turn Pinning

**Date:** 2026-11-11  
**Author:** Claude Code Engineer  
**Status:** Completed & Verified  

---

## 1. Problem Statement & Motivation

ClaudeCodeUI previously faced four usability and performance gaps across workspace monitoring, file inspection, and chat ergonomics:
1. **Subagent & Background Process Visibility:** Subagents and long-running background tasks were displayed exclusively as transient floating chips/toasts, making it difficult to inspect execution history, prompt parameters, and child activity logs.
2. **File Preview Capabilities:** The file browser and code editor only supported previewing Markdown files. HTML files opened in an external browser tab rather than in-frame, and Mermaid diagrams lacked inline rendering.
3. **Mobile Scroll Jitter & Page Jump:** Scrolling up on mobile devices to paginate older chat messages caused jarring page jumps and momentum jitter because touch gesture lifetimes conflicted with dynamic DOM insertion.
4. **Context Tracking in Deep Chats:** Long chat sessions made it hard for users to determine which user turn was being processed or reviewed while scrolling through historical transcripts.

---

## 2. Key Architectural Decisions & Implementation

### Phase 1: Dedicated Top-Level "Agents" Workspace Tab
- **Tab Integration:** Added `'agents'` to `AppTab` and `VALID_TABS` alongside `Chat`, `Terminal`, `Files`, and `Git` in `WorkspaceTabs.tsx`.
- **Live Activity Pulse:** Queried `useOptionalProcessingSessions()` from `SessionProtectionContext` to render animated pulse badges on the tab when background tasks or subagents are actively executing.
- **Shared Session Store:** Lifted `sessionStore = useSessionStore()` to `WorkspaceMain.tsx` to distribute the identical reactive store instance between `ChatInterface` and `AgentsWorkspaceView`, ensuring real-time transcript synchronization across tabs.
- **Hierarchy & Actions:**
  - `SubagentTreeList`: Lists subagents, workflows, and background CLI commands with duration counters and model badges.
  - `SubagentDetailView`: Displays the full task prompt, status, cancellation action (`chat.stop-task`), and child tool executions via `SubagentTimeline`.
  - Jump to chat navigates directly to the corresponding tool execution element in the transcript.

### Phase 2: Inline File Preview for HTML & Mermaid
- **HTML Isolation Sandbox:** Implemented `HtmlPreview.tsx` utilizing `<iframe sandbox="allow-scripts allow-forms allow-modals" srcDoc={content} />` omitting `allow-same-origin` to strictly isolate untrusted HTML from application origins, cookies, and local storage.
- **Mermaid Diagrams:** Created `MermaidFilePreview.tsx` integrating `MermaidDiagram` with automatic dark/light theme adaptation and syntax error fallback.
- **Unified Preview Toggle:** Reused the header eye toggle icon across Markdown, HTML, and Mermaid, rendering previews directly inside the editor frame without launching new browser windows.

### Phase 3: Mobile Momentum Scroll Stabilization
- **Touch Lifecycle Decoupling:** Monitored `isTouchActiveRef` across `onTouchStart`, `onTouchEnd`, and `onTouchCancel` in `ChatMessagesPane.tsx`. Suppressed `loadOlderMessages()` while the user's finger is actively in contact with the screen, deferring pagination evaluation until touch release.
- **Native CSS Scroll Anchoring:** Configured `overflowAnchor: 'auto'` and `overscrollBehaviorY: 'contain'` on `.chat-messages-pane`, while setting `overflowAnchor: 'none'` on transient loading skeletons and spinners to eliminate layout shift artifacts.

### Phase 4: Dynamic Pinned User Message Banner
- **Active Turn Tracking:** Tracked the visible message turn on scroll using lightweight `requestAnimationFrame` debouncing. When scrolled to the bottom, the banner smoothly locks onto the latest user prompt.
- **Visual Design & Expandability:** Truncated message content to 3 lines with ellipsis (`line-clamp-3 text-ellipsis`) by default with a chevron toggle to expand full text. Added a processing spinner indicator during assistant generation.
- **Virtualized Reveal & Text Selection Guard:** Integrated `revealMessage(msg)` to ensure unmounted virtualized transcript rows are mounted prior to executing `scrollIntoView`, and guarded click events against active text selection to allow copying prompt text without unintended jumping.

---

## 3. Verification & Quality Gates

- **Unit Test Suites (17/17 Passed):**
  - `src/modules/project-workspace/tests/agentsWorkspaceTab.test.tsx`: 4 passed
  - `src/modules/code-editor/tests/filePreviewInline.test.tsx`: 5 passed
  - `src/modules/chat/tests/mobileScrollRestore.test.tsx`: 2 passed
  - `src/modules/chat/tests/dynamicPinnedUserMessage.test.tsx`: 6 passed
- **TypeScript Type Checking:** `npx tsc --noEmit` passed with 0 errors.
- **Full Production Build:** `npm run build` (`vite build` + `tsc build:server`) passed cleanly.

---

## 4. Architectural Lessons & Best Practices

1. **State Store Distribution:** In React component trees with parallel top-level views, never create disconnected hook instances of stores that maintain internal message state. Hoist the store instance to the common ancestor (`WorkspaceMain.tsx`) to guarantee synchronous state.
2. **Module Boundary Encapsulation:** Always import cross-module dependencies through public module barrels (e.g., `src/modules/chat/index.ts`) to honor `.oxlintrc.json` dependency boundary contracts.
3. **Scroll Listener Optimization:** Avoid re-subscribing scroll handlers on streaming updates. Derive a lightweight stable signature (e.g., timestamp and length) to prevent listener churn during assistant token streaming.
