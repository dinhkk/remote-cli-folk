import '@/modules/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import CredentialsSettingsTab from '@/modules/settings/tabs/api-settings/CredentialsSettingsTab';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const key = (id: string, name: string, active: boolean) => ({
  id, key_name: name, api_key: `ck_${id}…`, created_at: '2026-01-01T00:00:00Z', last_used: null, is_active: active,
});

it('SF-03: after toggling an API key, focus stays on that key\'s toggle and the list keeps its order', async () => {
  const keys = [key('1', 'synthetic-first', true), key('2', 'synthetic-second', true), key('3', 'synthetic-third', false)];
  let listCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings/api-keys') { listCalls++; return Response.json({ apiKeys: keys.map((k) => ({ ...k })) }); }
    if (url.startsWith('/api/settings/credentials')) return Response.json({ credentials: [] });
    const toggle = url.match(/^\/api\/settings\/api-keys\/(\w+)\/toggle$/);
    if (toggle && init?.method === 'PATCH') {
      const target = keys.find((k) => k.id === toggle[1])!;
      target.is_active = JSON.parse(String(init.body)).isActive;
      return Response.json({ success: true });
    }
    return Response.json({}, { status: 404 });
  }));

  render(<CredentialsSettingsTab />);
  const row = (name: string) => screen.getByText(name).closest('.rounded-lg') as HTMLElement;
  await screen.findByText('synthetic-second');
  const button = within(row('synthetic-second')).getByRole('button', { name: 'Active' });
  button.focus();
  fireEvent.click(button);

  await waitFor(() => expect(listCalls).toBe(2));
  const after = await within(row('synthetic-second')).findByRole('button', { name: 'Inactive' });
  expect(document.activeElement).toBe(after);
  expect(screen.getAllByText(/^synthetic-/).map((node) => node.textContent))
    .toEqual(['synthetic-first', 'synthetic-second', 'synthetic-third']);
});
