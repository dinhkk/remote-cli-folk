/** How long to wait after the route switched to the chat, and how often to look for the row while the chat loads. */
const FIRST_LOOK_MS = 150;
const LOOK_EVERY_MS = 150;
/** The chat of another session loads from the server: give it a few seconds, then stop looking. */
const GIVE_UP_AFTER_MS = 4000;

/**
 * Scrolls the chat transcript to the row of a tool call (`id="tool-result-<toolId>"`, set by the transcript). Meant to be called
 * as the chat is being opened: the row does not exist until the chat has mounted and loaded, so it is looked for until it
 * shows up (or a few seconds pass). Not tied to a component, since the component that asks is gone once the chat opens.
 * Returns a function that stops looking.
 */
export function scrollToToolResult(toolId: string): () => void {
  const rowId = `tool-result-${toolId}`;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const look = () => {
    if (stopped) return;
    const row = document.getElementById(rowId);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (Date.now() - startedAt >= GIVE_UP_AFTER_MS) return;
    timer = setTimeout(look, LOOK_EVERY_MS);
  };

  timer = setTimeout(look, FIRST_LOOK_MS);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
