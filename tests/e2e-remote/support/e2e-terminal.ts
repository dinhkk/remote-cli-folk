// A real PTY on the Host driven through the Controller's `/r/<peer>/shell` socket, the way the terminal tab does it.
// The PTY runs a small line loop (answers `ECHO:<line>` and, for the line `size`, `SIZE:<cols>x<rows>`), so a test
// can time a keystroke round trip and see resizes without a real shell prompt.
import type { E2eServer } from './e2e-server.js';
import type { RemoteSocket } from './e2e-browser-client.js';

/**
 * The loop. Markers are assembled from two strings so that the command line itself (which a terminal may
 * show in its window title) never contains the text a test waits for.
 */
export const echoLoopCommand = (): string =>
  process.platform === 'win32'
    ? "Write-Output ('LOOP-' + 'READY'); while ($true) { $l = [Console]::In.ReadLine(); if ($null -eq $l) { break }; if ($l -eq 'size') { Write-Output ('SIZE:{0}x{1}' -f [Console]::WindowWidth, [Console]::WindowHeight) } else { Write-Output ('ECHO:' + $l) } }"
    : `echo LOOP-READY; while IFS= read -r l; do if [ "$l" = size ]; then set -- $(stty size); echo "SIZE:$2x$1"; else echo "ECHO:$l"; fi; done`;

/** The `init` message of a plain-shell tab running `command` in the Host's home. */
export const shellInit = (host: E2eServer, sessionId: string, command: string, size = { cols: 120, rows: 30 }): Record<string, unknown> => ({
  type: 'init',
  projectPath: host.home,
  sessionId,
  hasSession: false,
  provider: 'plain-shell',
  initialCommand: command,
  ...size,
});

/** Everything the terminal printed since message index `from`. */
export const outputText = (socket: RemoteSocket, from = 0): string =>
  socket.inbox
    .slice(from)
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');

/** Resolves with the milliseconds between sending `line` + Enter and the loop's answer containing `expected`. */
export function timeLine(socket: RemoteSocket, line: string, expected: string, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const startedAt = performance.now();
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.ws.off('message', onMessage);
      if (error) reject(error);
      else resolve(performance.now() - startedAt);
    };
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string; data?: unknown };
        if (message.type === 'output') seen += String(message.data);
      } catch {
        return;
      }
      if (seen.includes(expected)) finish();
    };
    const timer = setTimeout(() => finish(new Error(`no "${expected}" within ${timeoutMs} ms; tail: ${JSON.stringify(seen.slice(-200))}`)), timeoutMs);
    socket.ws.on('message', onMessage);
    socket.send({ type: 'input', data: `${line}\r` });
  });
}

/** One keystroke round trip: the loop answers `ECHO:<marker>`. */
export const timeEcho = (socket: RemoteSocket, marker: string, timeoutMs?: number): Promise<number> => timeLine(socket, marker, `ECHO:${marker}`, timeoutMs);

/** Opens a loop terminal and waits until it is ready for input. */
export async function openEchoTerminal(
  host: E2eServer,
  open: () => Promise<RemoteSocket>,
  sessionId: string,
  size?: { cols: number; rows: number },
): Promise<RemoteSocket> {
  const socket = await open();
  socket.send(shellInit(host, sessionId, echoLoopCommand(), size));
  await socket.waitFor((message) => message.type === 'output' && String(message.data).includes('LOOP-READY'), 'the echo loop to start', 60_000);
  return socket;
}
