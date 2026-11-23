import { getConnection } from '../../database/index.js';
import type { Database } from '../../database/index.js';

import { createSessionStore, migrateAuthSessions } from './session-store.service.js';

type SessionStore = ReturnType<typeof createSessionStore>;

/** Transport ownership is per browser session, independent of peer or provider jobs. */
export function createSessionConnections(store: SessionStore) {
  const connections = new Map<string, Set<() => void>>();
  const unsubscribe = store.onEnd(({ sessionId }) => {
    const pending = connections.get(sessionId);
    connections.delete(sessionId);
    for (const close of pending ?? []) {
      try { close(); } catch { /* Continue closing the other transports. */ }
    }
  });
  return {
    track(sessionId: string, close: () => void): () => void {
      if (!store.getActive(sessionId)) {
        close();
        return () => undefined;
      }
      const group = connections.get(sessionId) ?? new Set<() => void>();
      group.add(close);
      connections.set(sessionId, group);
      return () => {
        group.delete(close);
        if (group.size === 0) connections.delete(sessionId);
      };
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
  const { store } = getSessionRuntime();
  const timer = setInterval(() => store.expire(), 1000);
  timer.unref();
  return () => clearInterval(timer);
}
