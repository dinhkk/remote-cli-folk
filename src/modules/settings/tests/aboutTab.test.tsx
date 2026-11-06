import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { BRAND } from '@/shared/constants';

vi.mock('@/shared/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: '1.2.3',
    releaseInfo: null,
  }),
}));

const { default: AboutTab } = await import('@/modules/settings/tabs/AboutTab');

/**
 * Settings > About is the RemoteCLI page: its name, version, author and GitHub, the license, and a
 * single small line crediting the project it was adapted from. None of the original project's
 * promotion (star button, Discord, docs, hosted offer, Pro cards) is left.
 */

describe('Settings > About', () => {
  it('names RemoteCLI, its version, the author and the author\'s GitHub', () => {
    render(<AboutTab />);

    expect(screen.getByText('RemoteCLI')).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('Tùng Huynh')).toBeTruthy();
    const github = screen.getByText('tunghuynh').closest('a');
    expect(github?.getAttribute('href')).toBe('https://github.com/tunghuynh');
  });

  it('credits the original project in one line and nowhere else', () => {
    const { container } = render(<AboutTab />);

    const credit = screen.getByText(/adapted from the original/i);
    expect(credit.querySelector('a')?.getAttribute('href')).toBe(BRAND.upstreamUrl);
    expect(credit.textContent).toContain('cloudcli.ai');

    // The only link in the page that leaves for the original project is that credit.
    const toUpstream = [...container.querySelectorAll('a')].filter((a) => /cloudcli|siteboon/i.test(a.getAttribute('href') ?? ''));
    expect(toUpstream).toHaveLength(1);
  });

  it('has no star button, Discord, docs, hosted offer or Pro cards', () => {
    const { container } = render(<AboutTab />);

    for (const text of [/star on github/i, /discord/i, /^docs$/i, /hosted/i, /pro features/i, /sync settings/i, /team management/i]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(container.querySelector('a[href*="discord"]')).toBeNull();
    expect(container.querySelector('a[href*="siteboon"]')).toBeNull();
  });

  it('shows the RemoteCLI mark, not the chat bubble', () => {
    const { container } = render(<AboutTab />);

    expect(container.innerHTML).not.toContain('M21 15a2 2 0 0 1-2 2H7l-4 4V5');
    expect(container.querySelector('svg rect[width="18"][height="12"]')).not.toBeNull();
  });
});
