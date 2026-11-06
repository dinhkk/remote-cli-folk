/**
 * The Controller's view of its paired Hosts (contracts sections 1, 2): links open lazily (first
 * `GET /peers` or tab), close five minutes after the last browser attached, map link states to
 * `PeerState`, and end every browser connection of a peer when it is forgotten or its link drops.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RemoteBrowserConnection } from '@/shared/types.js';

import { createPeerRegistry } from '../../controller/peer-registry.service.js';
import { createFakeLink, type FakeLink } from '../support/fake-link.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMemoryPairingStore } from '../support/memory-pairing-store.js';

const MINUTE = 60_000;

const build = (options: { secret?: string | null; supported?: boolean } = {}) => {
  const clock = createManualClock(1_700_000_000_000);
  const store = createMemoryPairingStore(clock.now);
  const links: FakeLink[] = [];
  let secret = options.secret === undefined ? 'a'.repeat(32) : options.secret;
  let supported = options.supported ?? true;
  const registry = createPeerRegistry({
    store,
    getRelaySecret: () => secret,
    isSupported: () => supported,
    clock,
    appVersion: 'test',
    createLink: () => {
      const link = createFakeLink('controller');
      links.push(link);
      return link;
    },
  });
  return {
    clock,
    store,
    links,
    registry,
    setSecret: (value: string | null) => {
      secret = value;
    },
    setSupported: (value: boolean) => {
      supported = value;
    },
  };
};

const connection = (): RemoteBrowserConnection & { closed: Array<[number, string]> } => {
  const closed: Array<[number, string]> = [];
  return { closed, close: (code, reason) => void closed.push([code, reason]) };
};

describe('peer registry (Controller)', () => {
  it('opens no link until something asks (lazy), then one link per Controller pairing and never for Host pairings', () => {
    const { registry, store, links } = build();
    const a = store.add({ role: 'controller', name: 'Host A' });
    store.add({ role: 'controller', name: 'Host B' });
    store.add({ role: 'host', name: 'A Controller' });
    assert.equal(links.length, 0);

    const peers = registry.listPeers();
    assert.equal(peers.length, 2);
    assert.equal(links.length, 2);
    assert.ok(links.every((link) => link.started));
    assert.ok(peers.some((peer) => peer.peerId === a.id && peer.name === 'Host A'));

    registry.listPeers();
    assert.equal(links.length, 2, 'a second poll reuses the links');
  });

  it('lists the alias next to the declared name, and setAlias changes only what this Controller shows', () => {
    const { registry, store, links } = build();
    const peer = store.add({ role: 'controller', name: 'DESKTOP-9F3K2L' });
    store.add({ role: 'host', name: 'A Controller' });

    assert.equal(registry.listPeers()[0].alias, null);
    registry.setAlias(peer.id, 'Home PC');

    const [listed] = registry.listPeers();
    assert.equal(listed.alias, 'Home PC');
    assert.equal(listed.name, 'DESKTOP-9F3K2L', 'the declared name is still reported');
    assert.equal(links.length, 1, 'renaming opens no link and sends nothing to the Host');

    registry.setAlias(peer.id, null);
    assert.equal(registry.listPeers()[0].alias, null);
  });

  it('refuses an alias for an unknown pairing and for a pairing that is not a Host of this Controller', () => {
    const { registry, store } = build();
    const controllerRow = store.add({ role: 'host', name: 'A Controller' });

    assert.throws(() => registry.setAlias('nope', 'x'), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
    assert.throws(() => registry.setAlias(controllerRow.id, 'x'), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
  });

  it('maps the link status to PeerState and reports lastConnectedAt', () => {
    const { registry, store, links, clock } = build();
    const peer = store.add({ role: 'controller' });
    assert.equal(registry.listPeers()[0].state, 'connecting');
    for (const state of ['online', 'locked', 'replaced', 'revoked', 'offline'] as const) {
      links[0].setStatus({ peerState: state });
      assert.equal(registry.listPeers()[0].state, state);
    }
    links[0].setSession(true);
    const [view] = registry.listPeers();
    assert.equal(view.peerId, peer.id);
    assert.equal(view.lastConnectedAt, clock.now(), 'markConnected ran when the session came up');
  });

  it('reports offline, without opening links, when no relay secret is saved or the mode is unsupported', () => {
    const noSecret = build({ secret: null });
    noSecret.store.add({ role: 'controller' });
    assert.equal(noSecret.registry.listPeers()[0].state, 'offline');
    assert.equal(noSecret.links.length, 0);

    const unsupported = build({ supported: false });
    unsupported.store.add({ role: 'controller' });
    assert.equal(unsupported.registry.listPeers()[0].state, 'offline');
    assert.equal(unsupported.links.length, 0);
  });

  it('reports expired for a pairing past its idle expiry', () => {
    const { registry, store, clock } = build();
    store.add({ role: 'controller', expiresAt: clock.now() - 1 });
    assert.equal(registry.listPeers()[0].state, 'expired');
  });

  it('a pairing whose key cannot be opened shows offline instead of failing the whole list', () => {
    const { registry, store, links } = build();
    const bad = store.add({ role: 'controller', name: 'bad' });
    store.add({ role: 'controller', name: 'good' });
    store.failOpenKeyFor.add(bad.id);
    const peers = registry.listPeers();
    assert.equal(peers.find((peer) => peer.peerId === bad.id)?.state, 'offline');
    assert.equal(links.length, 1);
  });

  it('closes every link five minutes after the last browser touched it, and reopens lazily', () => {
    const { registry, store, links, clock } = build();
    store.add({ role: 'controller' });
    registry.listPeers();
    clock.advance(4 * MINUTE);
    assert.equal(links[0].closed, false);
    registry.listPeers(); // a poll counts as a browser being attached
    clock.advance(4 * MINUTE);
    assert.equal(links[0].closed, false, 'the poll renewed the lease');
    clock.advance(MINUTE + 1);
    assert.equal(links[0].closed, true);
    assert.equal(registry.openLinkCount, 0);

    registry.listPeers();
    assert.equal(links.length, 2, 'a new poll opens a fresh link');
    assert.equal(links[1].started, true);
  });

  it('keeps the links while a browser connection is open, however idle', () => {
    const { registry, store, links, clock } = build();
    const peer = store.add({ role: 'controller' });
    registry.attach(peer.id);
    const untrack = registry.trackConnection(peer.id, connection());
    clock.advance(30 * MINUTE);
    assert.equal(links[0].closed, false);
    untrack();
    clock.advance(6 * MINUTE);
    assert.equal(links[0].closed, true);
  });

  it('attach opens the link for one peer, touches the lease and refuses unknown or Host ids', () => {
    const { registry, store, links } = build();
    const peer = store.add({ role: 'controller' });
    const hostRow = store.add({ role: 'host' });
    assert.equal(registry.attach(peer.id), links[0]);
    assert.equal(registry.hasPeer(peer.id), true);
    assert.equal(registry.hasPeer(hostRow.id), false);
    assert.equal(registry.hasPeer('missing'), false);
    assert.throws(() => registry.attach('missing'), (error: { code?: string }) => error.code === 'REMOTE_PEER_NOT_FOUND');
    assert.throws(() => registry.attach(hostRow.id), (error: { code?: string }) => error.code === 'REMOTE_PEER_NOT_FOUND');
  });

  it('attach says the link is down (503) when there is no secret or the mode is unsupported', () => {
    const noSecret = build({ secret: null });
    const peer = noSecret.store.add({ role: 'controller' });
    assert.throws(() => noSecret.registry.attach(peer.id), (error: { code?: string }) => error.code === 'REMOTE_LINK_DOWN');
    const unsupported = build({ supported: false });
    const other = unsupported.store.add({ role: 'controller' });
    assert.throws(() => unsupported.registry.attach(other.id), (error: { code?: string }) => error.code === 'REMOTE_LINK_DOWN');
  });

  it('forgetting a peer closes its link and every browser connection of it, then deletes the pairing', () => {
    const { registry, store, links } = build();
    const peer = store.add({ role: 'controller' });
    const other = store.add({ role: 'controller' });
    registry.attach(peer.id);
    registry.attach(other.id);
    const mine = connection();
    const theirs = connection();
    registry.trackConnection(peer.id, mine);
    registry.trackConnection(other.id, theirs);

    registry.forget(peer.id);
    assert.equal(links[0].closed, true);
    assert.equal(mine.closed.length, 1);
    assert.equal(theirs.closed.length, 0, 'other peers are untouched');
    assert.equal(store.getPairing(peer.id), null);
    assert.equal(registry.hasPeer(peer.id), false);
    assert.throws(() => registry.forget(peer.id), (error: { code?: string }) => error.code === 'REMOTE_PEER_NOT_FOUND');
  });

  it('a Host pairing id cannot be forgotten through the Controller registry', () => {
    const { registry, store } = build();
    const hostRow = store.add({ role: 'host' });
    assert.throws(() => registry.forget(hostRow.id), (error: { code?: string }) => error.code === 'REMOTE_PEER_NOT_FOUND');
    assert.ok(store.getPairing(hostRow.id));
  });

  it('ends the browser connections of a peer when its session goes down, and only that peer', () => {
    const { registry, store, links } = build();
    const peer = store.add({ role: 'controller' });
    const other = store.add({ role: 'controller' });
    registry.attach(peer.id);
    registry.attach(other.id);
    const mine = connection();
    const theirs = connection();
    registry.trackConnection(peer.id, mine);
    registry.trackConnection(other.id, theirs);

    links[0].setSession(true);
    links[0].setSession(false);
    assert.equal(mine.closed.length, 1);
    assert.deepEqual(mine.closed[0][0], 1013, 'the browser is told to retry');
    assert.equal(theirs.closed.length, 0);
  });

  it('closeConnections ends every connection (the auth epoch changed) but leaves the links', () => {
    const { registry, store, links } = build();
    const a = store.add({ role: 'controller' });
    const b = store.add({ role: 'controller' });
    registry.attach(a.id);
    registry.attach(b.id);
    const first = connection();
    const second = connection();
    registry.trackConnection(a.id, first);
    registry.trackConnection(b.id, second);
    assert.equal(registry.closeConnections(), 2);
    assert.equal(first.closed.length + second.closed.length, 2);
    assert.ok(links.every((link) => !link.closed));
    assert.equal(registry.closeConnections(), 0, 'closing twice finds nothing');
  });

  it('a connection that closes itself is untracked and closing it again does nothing', () => {
    const { registry, store } = build();
    const peer = store.add({ role: 'controller' });
    registry.attach(peer.id);
    const conn = connection();
    const untrack = registry.trackConnection(peer.id, conn);
    untrack();
    untrack();
    assert.equal(registry.closeConnections(peer.id), 0);
    assert.equal(conn.closed.length, 0);
  });

  it('closeLinks (relay settings changed, shutdown) closes all links and connections and cancels the idle timer', () => {
    const { registry, store, links, clock } = build();
    const peer = store.add({ role: 'controller' });
    registry.attach(peer.id);
    const conn = connection();
    registry.trackConnection(peer.id, conn);
    registry.closeLinks();
    assert.ok(links.every((link) => link.closed));
    assert.equal(conn.closed.length, 1);
    assert.equal(registry.openLinkCount, 0);
    assert.equal(clock.pendingTimers(), 0);
  });

  it('a link that reports revoked stays listed as revoked and is not reopened by polling', () => {
    const { registry, store, links } = build();
    store.add({ role: 'controller' });
    registry.listPeers();
    links[0].setStatus({ state: 'revoked', peerState: 'revoked', reason: 'revoked' });
    assert.equal(registry.listPeers()[0].state, 'revoked');
    registry.listPeers();
    assert.equal(links.length, 1);
  });
});
