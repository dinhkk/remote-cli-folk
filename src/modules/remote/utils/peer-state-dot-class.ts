import type { RemotePeerState } from '@/shared/types';

/** Colour of the small status dot for each link state; shared by the tab bar and the Hosts list so both read the same. */
export const PEER_STATE_DOT_CLASS: Record<RemotePeerState, string> = {
  online: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  offline: 'bg-muted-foreground/50',
  locked: 'bg-red-500',
  replaced: 'bg-red-500',
  revoked: 'bg-red-500',
  expired: 'bg-red-500',
};
