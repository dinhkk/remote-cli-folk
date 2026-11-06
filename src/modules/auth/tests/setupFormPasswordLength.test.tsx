import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { AuthProvider } from '@/modules/auth/context/AuthContext';
import SetupForm from '@/modules/auth/SetupForm';

const MIN_LENGTH_MESSAGE = 'Password must be at least 12 characters long.';

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ needsSetup: true, isAuthenticated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'stop here' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function submitSetup(password: string) {
  render(
    <AuthProvider>
      <SetupForm />
    </AuthProvider>,
  );
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
}

const registerCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/register'));

describe('SetupForm password length', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses an 11 character password with the 12 character message and never calls register', async () => {
    const fetchMock = stubFetch();

    await submitSetup('12345678901');

    expect(await screen.findByText(MIN_LENGTH_MESSAGE)).toBeTruthy();
    expect(registerCalls(fetchMock)).toHaveLength(0);
  });

  it('sends a 12 character password to the server', async () => {
    const fetchMock = stubFetch();

    await submitSetup('123456789012');

    await waitFor(() => expect(registerCalls(fetchMock)).toHaveLength(1));
    expect(screen.queryByText(MIN_LENGTH_MESSAGE)).toBeNull();
  });

  it('shows the 12 character hint on the form', async () => {
    stubFetch();
    render(
      <AuthProvider>
        <SetupForm />
      </AuthProvider>,
    );

    expect(await screen.findByText('At least 3 characters for username, 12 for password.')).toBeTruthy();
  });
});
