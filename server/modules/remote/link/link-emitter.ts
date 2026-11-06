/**
 * Minimal typed event emitter for a relay link. A listener that throws must not break the link's
 * state machine (it would leave a half-applied transition), so listener errors are contained here.
 */

import type { RemoteLinkEvents } from '@/shared/types.js';

type AnyListener = (payload: unknown) => void;

export type LinkEmitter = {
  emit<E extends keyof RemoteLinkEvents>(event: E, payload: RemoteLinkEvents[E]): void;
  /** Subscribes; the returned function unsubscribes. */
  on<E extends keyof RemoteLinkEvents>(event: E, listener: (payload: RemoteLinkEvents[E]) => void): () => void;
  clear(): void;
};

// Consumed by: relay-link (its public `on` and its internal event emission).
export const createLinkEmitter = (): LinkEmitter => {
  const listeners = new Map<keyof RemoteLinkEvents, Set<AnyListener>>();
  return {
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        try {
          listener(payload);
        } catch {
          // A faulty subscriber is its own problem; the link keeps going.
        }
      }
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<AnyListener>();
      listeners.set(event, set);
      set.add(listener as AnyListener);
      return () => {
        set.delete(listener as AnyListener);
      };
    },
    clear() {
      listeners.clear();
    },
  };
};
