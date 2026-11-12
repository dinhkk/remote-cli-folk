const OPEN_TAB_EVENT = 'remotecli:remote-open-tab';
const LEGACY_OPEN_TAB_EVENT = 'cloudcli:remote-open-tab';

/**
 * Asks the Remote tab bar to bring one Host's tab to the front. Settings and the
 * tab bar live far apart in the tree and must not import each other, so the
 * request travels as a window event. Used by the Hosts list in Settings.
 */
export const requestOpenRemoteTab = (peerId: string): void => {
  window.dispatchEvent(new CustomEvent<string>(OPEN_TAB_EVENT, { detail: peerId }));
};

/** Listens for open-tab requests; returns the function that stops listening. Used by RemoteTabsShell. */
export const onOpenRemoteTabRequest = (listener: (peerId: string) => void): (() => void) => {
  const handler = (event: Event) => {
    const peerId = (event as CustomEvent<unknown>).detail;
    if (typeof peerId === 'string') listener(peerId);
  };
  window.addEventListener(OPEN_TAB_EVENT, handler);
  window.addEventListener(LEGACY_OPEN_TAB_EVENT, handler);
  return () => {
    window.removeEventListener(OPEN_TAB_EVENT, handler);
    window.removeEventListener(LEGACY_OPEN_TAB_EVENT, handler);
  };
};
