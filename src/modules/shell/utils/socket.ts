import { IS_PLATFORM } from '@/shared/utils';
import { getStoredAuthToken } from '@/shared/authToken';
import { isTargetMode, wsProtocols, wsUrl } from '@/shared/transport/target-context';

type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  forceRestart?: boolean;
  bypassPermissions?: boolean;
  // The app theme at launch, so the server can start a CLI in the colour scheme
  // the terminal is painted in.
  colorScheme?: 'light' | 'dark';
};

type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

type ShellInputMessage = {
  type: 'input';
  data: string;
};

type ShellOutgoingMessage = ShellInitMessage | ShellResizeMessage | ShellInputMessage;

type ShellIncomingMessage =
  | { type: 'output'; data: string }
  // Sent instead of starting a PTY when the project path or session id is
  // rejected, so this is the only signal that the terminal will never start.
  | { type: 'error'; message?: string }
  | { type: 'auth_url'; url?: string }
  // The app theme the Claude CLI in the pty was launched for. A running CLI
  // keeps those colours, including one a reconnect reattaches to.
  | { type: 'claude_theme'; colorScheme?: string }
  | { type: string; [key: string]: unknown };

export function getShellWebSocketUrl(): string | null {
  if (isTargetMode()) {
    // The token is not part of the URL: see getShellWebSocketProtocols.
    return getStoredAuthToken() ? wsUrl('/shell') : null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (IS_PLATFORM) {
    return `${protocol}//${window.location.host}/shell`;
  }

  const token = getStoredAuthToken();
  if (!token) {
    console.error('No authentication token found for Shell WebSocket connection');
    return null;
  }

  return `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
}

/**
 * Subprotocols to offer when opening the shell socket: the tab token in a Remote
 * tab, where the URL must stay token-free, and nothing in Local mode.
 */
export function getShellWebSocketProtocols(): string[] | undefined {
  return wsProtocols();
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
