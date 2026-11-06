/**
 * Permission requests that lapsed without an answer while a Remote tab was
 * disconnected or waiting (FR-31). When the tab reconnects and the server
 * replays `permission_cancelled`, the card would simply vanish; this small
 * external store keeps a visible "expired" notice instead, until dismissed.
 *
 * Module state with a subscribe/snapshot pair so a React component can read it
 * through useSyncExternalStore; the chat realtime handler writes to it.
 */

/** A permission request that expired before anyone answered it; shown by the composer's expired notice. */
export type ExpiredPermission = { requestId: string; toolName: string };

let expired: ExpiredPermission[] = [];
const listeners = new Set<() => void>();

const publish = (next: ExpiredPermission[]) => {
  expired = next;
  listeners.forEach((listener) => listener());
};

/** Remembers an expired request once, however many times the server replays its cancellation. */
export const recordExpiredPermission = (entry: ExpiredPermission): void => {
  if (expired.some((existing) => existing.requestId === entry.requestId)) {
    return;
  }
  publish([...expired, entry]);
};

/** Removes one notice, after the user dismissed it. */
export const dismissExpiredPermission = (requestId: string): void => {
  publish(expired.filter((entry) => entry.requestId !== requestId));
};

/** The current notices; the same array instance until something changes, as useSyncExternalStore requires. */
export const getExpiredPermissions = (): ExpiredPermission[] => expired;

/** Subscribes to changes; returns the unsubscribe function. */
export const subscribeExpiredPermissions = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
