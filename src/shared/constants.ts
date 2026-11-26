import {
  Bell,
  Bot,
  GitBranch,
  Info,
  KeyRound,
  ListChecks,
  MonitorPlay,
  Palette,
  Plug,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { FileStatusCode, LLMProvider, McpProvider, McpScope, McpTransport, SettingsMainTab } from '@/shared/types';
import type { UserPreferenceKey } from '@/shared/userSettings';

/** The four buckets the git changes view sorts working-tree files into. */
type GitStatusFileGroup = 'modified' | 'added' | 'deleted' | 'untracked';

//----------------- BRANDING ------------

/**
 * Font stack used to render the RemoteCLI wordmark consistently wherever the brand name
 * appears as text. Apply it inline so the wordmark does not inherit a themed font.
 */
export const BRAND_WORDMARK_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji';

/**
 * Who this build is and where to find them, as shown in Settings > About, the sidebar footer and the
 * sign-in page. Only what the user sees is branded: environment variables, storage keys, the package
 * name and data folders keep their original names so existing installs and configs keep working.
 */
export const BRAND = {
  name: 'RemoteCLI',
  author: 'Tùng Huynh',
  handle: 'tunghuynh',
  githubUrl: 'https://github.com/tunghuynh',
  /** The project this one was adapted from; credited in one line in Settings > About. */
  upstreamName: 'CloudCLI',
  upstreamUrl: 'https://cloudcli.ai',
} as const;

// ---------------------------

//----------------- APPLICATION VERSION ------------

/**
 * Version of the installed package, baked into the client bundle at build time.
 * Compare it with the version reported by `/api/auth/version` to detect a package that was
 * updated without restarting the server. Empty outside a Vite build (for example
 * under the `tsx` test runner), where no build-time value is injected.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

// ---------------------------

//----------------- SETTINGS NAVIGATION ------------

/** Shape of one entry in `SETTINGS_MAIN_TABS`; only that constant needs it. */
type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

/**
 * The ordered list of top-level settings tabs. The settings sidebar renders it directly and
 * the command palette turns each entry into an "open settings" command, so both stay in sync.
 */
export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'git', label: 'Git', keywords: 'git github commits', icon: GitBranch },
  { id: 'api', label: 'API Tokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'tasks', label: 'Tasks', keywords: 'tasks taskmaster', icon: ListChecks },
  { id: 'browser', label: 'Browser', keywords: 'browser playwright chromium automation', icon: MonitorPlay },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'plugins', label: 'Plugins', keywords: 'plugins extensions integrations', icon: Plug },
  { id: 'sessions', label: 'Sessions', keywords: 'devices sign out sessions', icon: KeyRound },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

// ---------------------------

//----------------- CHAT REASONING EFFORT ------------

/**
 * Sentinel effort value meaning "use whatever the model defaults to". The composer's model
 * menu renders it as the first choice and the provider state treats it as "no explicit effort".
 */
export const DEFAULT_EFFORT_VALUE = 'default';

// ---------------------------

//----------------- FILE UPLOAD LIMITS ------------

/** Largest single file the upload endpoint accepts, in megabytes. Source of truth for the two derived limits below. */
export const MAX_FILE_UPLOAD_SIZE_MB = 200;

/** `MAX_FILE_UPLOAD_SIZE_MB` in bytes, for comparing against `File.size` before uploading. */
export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

/** Human-readable form of the size limit, shown in the file tree header and in upload errors. */
export const MAX_FILE_UPLOAD_SIZE_LABEL = `${MAX_FILE_UPLOAD_SIZE_MB}MB`;

// ---------------------------

//----------------- GIT CHANGE GROUPS ------------

/** Shape of one entry in `FILE_STATUS_GROUPS`; only that constant needs it. */
type GitStatusGroupEntry = {
  key: GitStatusFileGroup;
  status: FileStatusCode;
};

/**
 * The order in which the git changes view groups files, and the status code each group holds.
 * Both the change list and the status-grouping helper iterate it so the two stay aligned.
 */
export const FILE_STATUS_GROUPS: GitStatusGroupEntry[] = [
  { key: 'modified', status: 'M' },
  { key: 'added', status: 'A' },
  { key: 'deleted', status: 'D' },
  { key: 'untracked', status: 'U' },
];

// ---------------------------

//----------------- MCP SERVER CAPABILITIES ------------

/** Display name for each provider that can host MCP servers, used in headings and buttons. */
export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Scopes each provider can install an MCP server into; drives the scope selector and validation. */
export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  cursor: ['user', 'project'],
  codex: ['user', 'project'],
  opencode: ['user', 'project'],
};

/** Transports each provider can talk to an MCP server over; drives the transport selector and validation. */
export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http'],
  codex: ['stdio', 'http'],
  opencode: ['stdio', 'http'],
};

/** Transports offered when configuring a global (provider-agnostic) MCP server. */
export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];

/** Whether a provider honours an MCP server's working-directory setting; the form hides the field when it does not. */
export const MCP_SUPPORTS_WORKING_DIRECTORY: Record<McpProvider, boolean> = {
  claude: false,
  cursor: false,
  codex: true,
  opencode: false,
};

// ---------------------------

//----------------- QUICK SETTINGS PANEL ROWS ------------

/**
 * Class list for one row in the quick settings panel. Shared so plain rows and the clickable
 * toggle row (which appends `cursor-pointer`) stay visually identical.
 */
export const SETTING_ROW_CLASS =
  'flex items-center justify-between p-3 rounded-lg bg-muted/60 hover:bg-accent transition-colors border border-transparent hover:border-border';

// ---------------------------

//----------------- TERMINAL TIMING ------------

/**
 * Delay before the terminal is measured and fitted after it is attached. Gives the browser one
 * layout pass so the initial fit and the resize message sent to the backend use real dimensions.
 */
export const TERMINAL_INIT_DELAY_MS = 100;

// ---------------------------

//----------------- CODE EDITOR DISPLAY SETTINGS ------------

/**
 * The four localStorage keys the code-editor display settings used to live
 * under, kept only so `userSettings` can migrate an existing install onto the
 * stored `codeEditorSettings` preference. Nothing writes them any more.
 */
export const CODE_EDITOR_STORAGE_KEYS = {
  wordWrap: 'codeEditorWordWrap',
  showMinimap: 'codeEditorShowMinimap',
  lineNumbers: 'codeEditorLineNumbers',
  fontSize: 'codeEditorFontSize',
} as const;

/**
 * Values applied when a code-editor setting has never been written. These are
 * the editor's own historical defaults; the settings dialog used to carry its
 * own copy with a different fontSize, so merely opening it rewrote the user's
 * editor font.
 */
export const CODE_EDITOR_DEFAULTS = {
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '12',
} as const;


// ---------------------------

//----------------- PROVIDER TOOL SETTINGS STORAGE ------------

/**
 * Per-provider preference key holding that provider's tool-permission
 * settings, sent with every `chat.send`.
 *
 * `opencode` intentionally maps to its own key even though no settings UI
 * writes it yet: without the entry the lookup would fall through to Claude's
 * key and OpenCode sessions would silently inherit Claude's `skipPermissions`.
 */
export const PROVIDER_PERMISSION_PREFERENCE_KEYS: Record<LLMProvider, UserPreferenceKey> = {
  claude: 'claudePermissions',
  cursor: 'cursorPermissions',
  codex: 'codexPermissions',
  opencode: 'opencodePermissions',
};

// ---------------------------

//----------------- REMOTE TAB TOKEN RENEWAL ------------

/**
 * Shortest gap between two requests for a new tab token, applied on both ends of
 * the page <-> tab link: the frame will not ask more often than this and the
 * Controller page will not answer more often than this, so a token that keeps
 * failing cannot turn into a request storm against the management API.
 */
export const TAB_TOKEN_REQUEST_MIN_INTERVAL_MS = 60_000;

//----------------- REMOTE TABS ------------

/** How often a pairing dialog follows its join while it is open: the person is waiting on the other device, so this stays short. */
export const REMOTE_PEERS_POLL_INTERVAL_MS = 2_000;

/**
 * How often the shared Remote poll (tab bar, settings, Local badge) re-reads peers and Host status.
 * Every one of these requests crosses the relay, so the steady state is kept slow; a person who acts
 * gets a fresh read at once through `refresh`, and a tab that is shown again catches up immediately.
 */
export const REMOTE_STATUS_POLL_INTERVAL_MS = 5_000;

/** How often the running-sessions list is re-read while the page is visible; live runs also arrive over the websocket. */
export const RUNNING_SESSIONS_POLL_INTERVAL_MS = 10_000;

/** How often a visible composer re-reads the server's copy of its queued follow-up. */
export const QUEUED_DRAFT_RECONCILE_INTERVAL_MS = 10_000;

/** How long a link-error message stays on a Remote tab before it hides itself. */
export const TARGET_LINK_ERROR_AUTOHIDE_MS = 8_000;

/** Shortest gap between two re-issues of a Remote tab frame after it loaded a foreign document, so a frame that reloads itself in a loop cannot spin. */
export const REMOTE_FRAME_REISSUE_MIN_INTERVAL_MS = 3_000;

// ---------------------------

//----------------- AGENT PROFILES ------------

/**
 * Tool names of Claude Code 0.3.x (measured on SDK 0.3.165, Windows). Offered by the tool pickers of the
 * template and agent forms so tool names are never typed by hand. The set depends on the CLI version and OS;
 * the pickers still accept a name that is not listed. `Agent` is the delegation tool (alias `Task`).
 */
export const CLAUDE_CODE_TOOL_NAMES: readonly string[] = [
  'Agent', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'Monitor',
  'NotebookEdit', 'PowerShell', 'PushNotification', 'Read', 'ScheduleWakeup', 'Skill', 'TaskCreate',
  'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
];

/** Names of the tool an orchestrator delegates with (`Task` is the older alias of `Agent`); an orchestrator template that excludes both cannot hand work to agents. */
export const AGENT_DELEGATION_TOOL_NAMES: readonly string[] = ['Agent', 'Task'];

/** Placeholder keys the project record fills by itself; a template may use them without declaring a parameter and may not declare a parameter with one of these keys. Mirrors the server's `RESERVED_PARAM_KEYS`. */
export const AGENT_PROFILE_RESERVED_KEYS: readonly string[] = ['project_name', 'project_directory'];

// ---------------------------
