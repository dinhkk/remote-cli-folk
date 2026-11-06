import type { RemotePeer } from '@/shared/types';

/**
 * The name to show for a paired Host: the alias the user gave it, else the device name the Host declared
 * (which is often an unreadable machine or container name). Used by the tab bar and the Hosts list.
 */
export const peerDisplayName = (peer: Pick<RemotePeer, 'name' | 'alias'>): string => peer.alias ?? peer.name;
