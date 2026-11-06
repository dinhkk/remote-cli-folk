/**
 * The refusal of an oversized upload on the Controller's `/r/<peerId>/**` proxy (contracts sections 6 and 7).
 *
 * Answering 413 at once and closing the connection resets it under a browser that is still sending, and the
 * reset can overtake the answer (the browser then reports a network error instead of "too large"). So the body
 * of a refused upload is read and dropped first, and the 413 is sent when the browser finished, with
 * `Connection: close`, after which the socket is destroyed and nothing more is read.
 *
 * Every limit is a hard stop, not a hint: the drain answers and cuts the connection when its time budget runs
 * out, when more than its byte budget was read (the chunked case has no declared length, so the bytes are the
 * only measure), or when the browser goes away; at most a few drains run per pairing and in total (the excess is
 * refused at once and the connection closed without reading anything); and a running drain is registered as a
 * browser connection of the pairing, so unpairing, a link going down or "log out everywhere" cuts it.
 * Nothing is forwarded or kept.
 */

import type { Request, Response } from 'express';

import type { RemoteBrowserConnection } from '@/shared/types.js';

const MIB = 1024 * 1024;

export type RefusedUploadBudgets = {
  /** Longest a refused upload is read before the refusal is sent anyway and the connection cut (ms). */
  graceMs: number;
  /** Most bytes read and dropped before the refusal is sent anyway and the connection cut. */
  maxBytes: number;
  /** Refused uploads drained at the same time for one pairing; the next one is refused at once. */
  perPairing: number;
  /** Refused uploads drained at the same time in total. */
  global: number;
};

// Consumed by: the Controller HTTP proxy (default budgets).
export const DEFAULT_REFUSED_UPLOAD_BUDGETS: RefusedUploadBudgets = { graceMs: 15_000, maxBytes: 128 * MIB, perPairing: 4, global: 16 };

const ENV_KEYS = {
  graceMs: 'CLOUDCLI_REMOTE_REFUSED_UPLOAD_GRACE_MS',
  maxBytes: 'CLOUDCLI_REMOTE_REFUSED_UPLOAD_MAX_MIB',
  perPairing: 'CLOUDCLI_REMOTE_REFUSED_UPLOAD_PER_PAIRING',
  global: 'CLOUDCLI_REMOTE_REFUSED_UPLOAD_GLOBAL',
} as const;

const positive = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * The budgets in force: the defaults, overridden by `CLOUDCLI_REMOTE_REFUSED_UPLOAD_{GRACE_MS,MAX_MIB,PER_PAIRING,GLOBAL}`
 * (positive numbers; anything else is ignored) and then by explicit `overrides` (positive numbers, raw units).
 * Consumed by: the Controller HTTP proxy.
 */
export const resolveRefusedUploadBudgets = (env: NodeJS.ProcessEnv = {}, overrides: Partial<RefusedUploadBudgets> = {}): RefusedUploadBudgets => {
  const resolved: RefusedUploadBudgets = { ...DEFAULT_REFUSED_UPLOAD_BUDGETS };
  for (const key of Object.keys(ENV_KEYS) as Array<keyof RefusedUploadBudgets>) {
    const fromEnv = positive(env[ENV_KEYS[key]]);
    if (fromEnv !== null) resolved[key] = Math.max(1, Math.floor(key === 'maxBytes' ? fromEnv * MIB : fromEnv));
    const override = positive(overrides[key]);
    if (override !== null) resolved[key] = Math.max(1, Math.floor(override));
  }
  return resolved;
};

export type RefusedUploadDrain = {
  /**
   * Refuses the request body of `req`: drains it within the budgets, then calls `respond` (which must write the
   * answer on `res`) with `Connection: close` set, and destroys the connection once the answer is flushed.
   * The byte budget counts what is read from here on (a chunked body that grew past the limit has its own count).
   */
  refuse(req: Request, res: Response, peerId: string, respond: () => void): void;
  /** Drains running right now (for tests and diagnostics). */
  readonly active: number;
};

type DrainDeps = {
  budgets: RefusedUploadBudgets;
  registry: { trackConnection(peerId: string, connection: RemoteBrowserConnection): () => void };
};

/**
 * Creates the drain shared by every refused upload of one Controller proxy.
 * Consumed by: the Controller HTTP proxy.
 */
export function createRefusedUploadDrain({ budgets, registry }: DrainDeps): RefusedUploadDrain {
  let active = 0;
  const perPeer = new Map<string, number>();

  /** Writes the answer, then ends the connection: the answer is flushed first, nothing more is read afterwards. */
  const answerAndClose = (req: Request, res: Response, respond: () => void): void => {
    req.pause(); // no further body bytes are consumed while the answer goes out
    if (res.destroyed || res.headersSent) {
      res.destroy();
      return;
    }
    res.setHeader('Connection', 'close');
    res.once('finish', () => req.socket?.destroy());
    respond();
  };

  return {
    get active() {
      return active;
    },
    refuse(req, res, peerId, respond) {
      // A write that races a dying socket may surface as an error; the 'close' below does the cleanup.
      res.on('error', () => undefined);
      req.on('error', () => undefined);

      const forPeer = perPeer.get(peerId) ?? 0;
      if (forPeer >= budgets.perPairing || active >= budgets.global) {
        answerAndClose(req, res, respond);
        return;
      }
      active += 1;
      perPeer.set(peerId, forPeer + 1);

      let done = false;
      let seen = 0;
      let untrack: () => void = () => undefined;
      let timer: NodeJS.Timeout | undefined;
      let onData: (chunk: Buffer) => void = () => undefined;
      let onEnd: () => void = () => undefined;
      /** Ends the drain once: releases the counters, the timer, the listeners and the registry entry. */
      const release = (): boolean => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        untrack();
        active -= 1;
        const left = (perPeer.get(peerId) ?? 1) - 1;
        if (left > 0) perPeer.set(peerId, left);
        else perPeer.delete(peerId);
        return true;
      };
      const settle = (answer: boolean): void => {
        if (!release()) return;
        if (answer) answerAndClose(req, res, respond);
      };
      onData = (chunk) => {
        seen += chunk.length;
        if (seen > budgets.maxBytes) settle(true);
      };
      onEnd = () => settle(true);
      timer = setTimeout(() => settle(true), budgets.graceMs);
      timer.unref();

      untrack = registry.trackConnection(peerId, {
        // Revoke, unpair, link down, auth epoch: the browser gets no answer, the connection is cut.
        close: () => {
          if (release()) res.destroy();
        },
      });
      // The browser went away before it finished: nobody can read an answer.
      res.once('close', () => settle(false));
      req.on('data', onData);
      req.once('end', onEnd);
      req.resume();
    },
  };
}
