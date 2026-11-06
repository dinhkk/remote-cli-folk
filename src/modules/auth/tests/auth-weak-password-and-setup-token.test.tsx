import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { AuthProvider, ProtectedRoute } from '@/modules/auth';
import SetupForm from '@/modules/auth/SetupForm';

/**
 * Two server behaviours from the hardened login that had no client yet: a
 * login with a password that predates the 12 character rule answers
 * `passwordWeak: true` and the user should be nudged to change it; and when the
 * operator pins registration with CLOUDCLI_SETUP_TOKEN the first registrant has
 * to be able to type it.
 */

const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const validToken = () => {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256' })}.${encode({ iat: now, exp: now + 3600 })}.sig`;
};

describe('weak password banner', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  const stubLogin = (loginBody: Record<string, unknown>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/status') return jsonReply({ needsSetup: false });
        if (url === '/api/auth/login') return jsonReply({ success: true, user: { id: 1, username: 'alice' }, token: validToken(), ...loginBody });
        if (url === '/api/user/onboarding-status') return jsonReply({ hasCompletedOnboarding: true });
        return jsonReply({});
      }),
    );

  const signIn = async () => {
    render(
      <AuthProvider>
        <ProtectedRoute>
          <div data-testid="workspace" />
        </ProtectedRoute>
      </AuthProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    await screen.findByTestId('workspace');
  };

  it('is shown after a login the server flagged as weak, and can be dismissed', async () => {
    stubLogin({ passwordWeak: true });

    await signIn();

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/12 characters/i);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is absent after an ordinary login', async () => {
    stubLogin({});

    await signIn();

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('setup token field', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  const stubRegister = () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/status') return jsonReply({ needsSetup: true });
      return jsonReply({ success: false, error: { code: 'X', message: 'stop here' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  const fill = async (setupToken?: string) => {
    render(
      <AuthProvider>
        <SetupForm />
      </AuthProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-pass' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'a-long-enough-pass' } });
    if (setupToken !== undefined) {
      fireEvent.change(screen.getByLabelText(/setup token/i), { target: { value: setupToken } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
  };

  const registerBody = (fetchMock: ReturnType<typeof stubRegister>) => {
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const call = calls.find(([url]) => String(url) === '/api/auth/register');
    return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
  };

  it('sends the typed setup token in the register body', async () => {
    const fetchMock = stubRegister();

    await fill('s3cret-token');

    await waitFor(() => expect(registerBody(fetchMock)).toMatchObject({ username: 'alice', setupToken: 's3cret-token' }));
  });

  it('masks the token and keeps password managers from offering to save it as the account login', async () => {
    stubRegister();
    render(
      <AuthProvider>
        <SetupForm />
      </AuthProvider>,
    );

    const field = (await screen.findByLabelText(/setup token/i)) as HTMLInputElement;

    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('new-password');
    expect(field.getAttribute('data-lpignore')).toBe('true');
    expect(field.getAttribute('data-1p-ignore')).toBe('true');
    expect(/user|login|pass|email/i.test(field.name)).toBe(false);
    // The real account fields stay fillable by managers.
    expect((screen.getByLabelText('Username') as HTMLInputElement).autocomplete).toBe('username');
    expect((screen.getByLabelText('Password') as HTMLInputElement).autocomplete).toBe('new-password');
  });

  it('omits setupToken from the body when the field is left empty', async () => {
    const fetchMock = stubRegister();

    await fill();

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/auth/register')).toBe(true));
    expect('setupToken' in registerBody(fetchMock)).toBe(false);
  });
});
