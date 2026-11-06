// Relay Worker: checks the gate, then hands the WebSocket to the Room Durable Object of
// `<kind>:<room>`. It serves no static files and adds no CORS headers (not needed by the relay).

import { checkGate, isRelayConfigured, notConfigured } from './gate';
import { Room } from './room';
import type { Env } from './types';

export { Room };

const plain = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'method not allowed');
      // Healthy only when /ws can actually work; never says whether the secret is missing or weak.
      return isRelayConfigured(env) ? plain(200, 'ok') : notConfigured();
    }
    if (pathname !== '/ws') return plain(404, 'not found');

    const checked = await checkGate(request, env);
    if (checked instanceof Response) return checked;

    const stub = env.ROOM.get(env.ROOM.idFromName(`${checked.kind}:${checked.room}`));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
