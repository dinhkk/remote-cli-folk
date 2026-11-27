/** Name of the window event that says "the pending proposals changed here" (confirmed or rejected), so every count on screen asks again. */
const PENDING_CHANGED_EVENT = 'agent-profiles:pending-changed';

/** Tells every mounted pending count to read again. Called after a proposal was confirmed or rejected. */
export function notifyPendingChanged(): void {
  window.dispatchEvent(new Event(PENDING_CHANGED_EVENT));
}

/** Calls `listener` whenever {@link notifyPendingChanged} fires; returns the function that stops listening. */
export function onPendingChanged(listener: () => void): () => void {
  window.addEventListener(PENDING_CHANGED_EVENT, listener);
  return () => window.removeEventListener(PENDING_CHANGED_EVENT, listener);
}
