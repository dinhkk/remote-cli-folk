// Only navigation identifiers are saved; never tokens or handshake nonces.
export const SELECTED_REMOTE_TAB_KEY = 'remotecli:selected-host';
export const REMOTE_SESSION_PATH_KEY = 'remotecli:last-session-path';

export function readSelectedRemoteTab(): string {
  try {
    const value = sessionStorage.getItem(SELECTED_REMOTE_TAB_KEY);
    return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : 'local';
  } catch { return 'local'; }
}

export function writeSelectedRemoteTab(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(SELECTED_REMOTE_TAB_KEY);
    else sessionStorage.setItem(SELECTED_REMOTE_TAB_KEY, value);
  } catch { /* Navigation still works when browser storage is unavailable. */ }
}

export function isSessionPath(value: string | null): value is string {
  return Boolean(value && /^\/session\/[A-Za-z0-9_-]{1,128}$/.test(value));
}
