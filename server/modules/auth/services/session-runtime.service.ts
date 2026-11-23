import { getConnection } from '../../database/index.js';
import type { Database } from '../../database/index.js';

import { createSessionStore, migrateAuthSessions, type ConnectionEndReason } from './session-store.service.js';

type SessionStore = ReturnType<typeof createSessionStore>;

/** Transport ownership is per browser session, independent of peer or provider jobs. */
export function createSessionConnections(store: SessionStore) {
  const connections = new Map<string, Set<(reason: ConnectionEndReason) => void>>();
  const unsubscribe = store.onEnd(({ sessionId, reason }) => {
    const pending = connections.get(sessionId);
    connections.delete(sessionId);
    for (const close of pending ?? []) {
      try { close(reason); } catch { /* Continue closing the other transports. */ }
    }
  });
  return {
    track(sessionId: string, close: (reason: ConnectionEndReason) => void): () => void {
      if (!store.getActive(sessionId)) {
        close(store.getCurrent(sessionId)?.lockedAt != null ? 'locked' : 'expired');
        return () => undefined;
      }
      const group = connections.get(sessionId) ?? new Set<(reason: ConnectionEndReason) => void>();
      group.add(close);
      connections.set(sessionId, group);
      return () => {
        group.delete(close);
        if (group.size === 0) connections.delete(sessionId);
      };
    },
    sweep() {
      for (const [id, group] of connections) {
        if (store.getActive(id)) continue;
        // getActive may synchronously lock the session and notify all listeners.
        if (!connections.has(id)) continue;
        connections.delete(id);
        const reason = store.getCurrent(id)?.lockedAt != null ? 'locked' : 'expired';
        for (const close of group) { try { close(reason); } catch { /* Close all transports. */ } }
      }
    },
    dispose() { unsubscribe(); connections.clear(); },
  };
}

const runtimes = new WeakMap<Database, { store: SessionStore; connections: ReturnType<typeof createSessionConnections> }>();

/** Resolve lazily so importing auth never opens the production database in a test. */
export function getSessionRuntime() {
  const db = getConnection();
  let runtime = runtimes.get(db);
  if (!runtime) {
    migrateAuthSessions(db);
    const store = createSessionStore(db);
    runtime = { store, connections: createSessionConnections(store) };
    runtimes.set(db, runtime);
  }
  return runtime;
}

/** One server lifecycle timer. Tests drive store.expire with a fake clock instead. */
export function startSessionExpiry(): () => void {
  const { store, connections } = getSessionRuntime();
  const timer = setInterval(() => { store.expire(); connections.sweep(); }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
