import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * A stand-in for the `/api/remote/*` management API (contracts.md section 2),
 * installed as the global `fetch`. Tests register one handler per
 * `METHOD /path` (`:name` segments match anything) and read back every request
 * the UI made, so they assert on what went over the wire, not on internals.
 */

export type FakeCall = { method: string; path: string; body: Record<string, unknown> | null };
export type FakeReply = { status?: number; body?: unknown };
export type FakeHandler = (call: FakeCall) => FakeReply | Promise<FakeReply>;

/** A JSON answer with the given status (200 by default). */
export const reply = (body: unknown, status = 200): FakeReply => ({ status, body });

/** The error envelope the server uses: `{ error: { code, message } }`. */
export const failure = (status: number, code: string, message = code): FakeReply => ({
  status,
  body: { error: { code, message } },
});

const matches = (pattern: string, path: string): boolean => {
  const want = pattern.split('/');
  const have = path.split('/');
  return want.length === have.length && want.every((part, index) => part.startsWith(':') || part === have[index]);
};

export const installFakeRemoteApi = (initial: Record<string, FakeHandler | FakeReply> = {}) => {
  const handlers = new Map<string, FakeHandler>();
  const calls: FakeCall[] = [];

  const set = (route: string, handler: FakeHandler | FakeReply) => {
    handlers.set(route, typeof handler === 'function' ? handler : () => handler);
  };
  for (const [route, handler] of Object.entries(initial)) set(route, handler);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = String(input);
      const call: FakeCall = {
        method,
        path,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      const route = [...handlers.keys()].find((key) => {
        const [routeMethod, routePath] = key.split(' ');
        // A query string is not part of the route; `calls` keeps it for tests that assert on parameters.
        return routeMethod === method && matches(routePath ?? '', path.split('?')[0] ?? '');
      });
      if (!route) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
      }
      const answer = await handlers.get(route)!(call);
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );

  return {
    calls,
    set,
    /** Requests that matched `METHOD /path` exactly. */
    to: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path),
  };
};

/** Lets pending promises and (when fake timers are on) timers up to `ms` run inside `act`. */
export const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
