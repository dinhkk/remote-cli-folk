import type { RemotePeer, RemotePeerState } from '@/shared/types';

const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PEER_STATES: ReadonlySet<string> = new Set<RemotePeerState>([
  'connecting',
  'online',
  'offline',
  'locked',
  'replaced',
  'revoked',
  'expired',
]);

/**
 * Keeps only well-formed pairings; whatever the server sends, a peerId reaches a
 * URL and a frame `src`. Used by the tab bar's own poll and by the shared status poll.
 */
export const parseRemotePeers = (body: unknown): RemotePeer[] => {
  if (!Array.isArray(body)) {
    return [];
  }
  const peers: RemotePeer[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const { peerId, name, alias, state, lastConnectedAt } = entry as Record<string, unknown>;
    if (typeof peerId !== 'string' || !PEER_ID_PATTERN.test(peerId)) continue;
    if (typeof name !== 'string' || typeof state !== 'string' || !PEER_STATES.has(state)) continue;
    peers.push({
      peerId,
      name,
      // An older server does not send it; blank means "none".
      alias: typeof alias === 'string' && alias.trim() !== '' ? alias : null,
      state: state as RemotePeerState,
      lastConnectedAt:
        typeof lastConnectedAt === 'string' || typeof lastConnectedAt === 'number' ? lastConnectedAt : null,
    });
  }
  return peers;
};
