import { afterEach, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '@/shared/api';
import { registerMfaReauth, requestMfaReauth } from '@/shared/authToken';

afterEach(() => vi.unstubAllGlobals());
it('C-09: concurrent requests share one reauth prompt; only rejected operations retry once', async () => {
  let finish!: (ok: boolean) => void;
  const prompt = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const remove = registerMfaReauth(prompt);
  const first = requestMfaReauth(), second = requestMfaReauth();
  expect(prompt).toHaveBeenCalledTimes(1); finish(true);
  expect(await first).toBe(true); expect(await second).toBe(true); remove();
  const unregister = registerMfaReauth(async () => true);
  const fetcher = vi.fn().mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'MFA_REAUTH_REQUIRED' }), { status: 403 }))
    .mockImplementationOnce(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  try { expect((await authenticatedFetch('/api/settings/api-keys', { method: 'POST', body: '{}' })).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2); }
  finally { unregister(); }
});
it('C-09: cancelling reauth leaves the action refused and does not retry', async () => {
  const remove = registerMfaReauth(async () => false);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'MFA_REAUTH_REQUIRED' } }), { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  try { expect((await authenticatedFetch('/api/settings/api-keys', { method: 'POST', body: '{}' })).status).toBe(403); expect(fetcher).toHaveBeenCalledTimes(1); }
  finally { remove(); }
});
