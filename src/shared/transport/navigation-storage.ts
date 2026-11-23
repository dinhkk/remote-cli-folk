/** Navigation identifiers only; authentication data never belongs in this store. */
export const SELECTED_REMOTE_TAB_KEY = 'remotecli:selected-host';
const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function clearSelectedRemoteTab(): void {
  try { sessionStorage.removeItem(SELECTED_REMOTE_TAB_KEY); } catch { /* Storage may be unavailable. */ }
}

export function readSelectedRemoteTab(): string {
  try {
    const value = sessionStorage.getItem(SELECTED_REMOTE_TAB_KEY);
    if (value && value !== 'local' && HOST_ID.test(value)) return value;
    if (value !== null) clearSelectedRemoteTab();
  } catch { /* An unavailable session store falls back to Local. */ }
  return 'local';
}

export function writeSelectedRemoteTab(peerId: string): void {
  if (peerId === 'local' || !HOST_ID.test(peerId)) {
    clearSelectedRemoteTab();
    return;
  }
  try { sessionStorage.setItem(SELECTED_REMOTE_TAB_KEY, peerId); } catch { /* Selection still works without persistence. */ }
}
