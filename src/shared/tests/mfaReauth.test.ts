import { afterEach, expect, it, vi } from 'vitest';

import { api, authenticatedFetch } from '@/shared/api';
import { AUTH_SESSION_LOCKED_EVENT, AUTH_SESSION_EXPIRED_EVENT, registerMfaReauth, requestMfaReauth } from '@/shared/authToken';

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


it.each([false, true])('L-02: a locked response preserves the session and never retries the refused action (reauth=%s)', async reauth => {
  const locked = vi.fn(), expired = vi.fn();
  window.addEventListener(AUTH_SESSION_LOCKED_EVENT, locked);
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  const remove = registerMfaReauth(async () => true);
  const fetcher = vi.fn();
  if (reauth) fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'MFA_REAUTH_REQUIRED' }), { status: 403 }));
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 'AUTH_SESSION_LOCKED' }), { status: 423 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    expect((await authenticatedFetch('/api/settings/api-keys', { method: 'POST', body: '{}' })).status).toBe(423);
    expect(locked).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(reauth ? 2 : 1);
  } finally {
    remove();
    window.removeEventListener(AUTH_SESSION_LOCKED_EVENT, locked);
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  }
});


it.each(['{"code":"RESOURCE_LOCKED"}', 'not-json'])('L-02: unrelated or malformed 423 responses do not lock the browser session', async body => {
  const locked = vi.fn();
  window.addEventListener(AUTH_SESSION_LOCKED_EVENT, locked);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 423 })));
  try {
    const response = await authenticatedFetch('/api/files');
    expect(response.status).toBe(423);
    expect(await response.text()).toBe(body);
    expect(locked).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(AUTH_SESSION_LOCKED_EVENT, locked);
  }
});


it.each([true, false])('R7-01: API key toggle prompts on server request and retries only after confirmation (%s)', async confirmed => {
  const prompt = vi.fn(async () => confirmed);
  const unregister = registerMfaReauth(prompt);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 'MFA_REAUTH_REQUIRED' }), { status: 403 }))
    .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    expect((await api.settings.toggleApiKey('7', true)).status).toBe(confirmed ? 200 : 403);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(confirmed ? 2 : 1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PATCH', body: '{"isActive":true}' });
    if (confirmed) expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
  } finally { unregister(); }
});
