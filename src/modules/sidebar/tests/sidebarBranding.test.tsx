import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import SidebarHeader from '@/modules/sidebar/SidebarHeader';
import { BRAND } from '@/shared/constants';

/**
 * The sidebar carries the RemoteCLI identity and none of the original project's promotion: no
 * "Report issue" / "Join community" links in the footer or the collapsed rail, and no GitHub star
 * badge in the header.
 */

const t = i18n.getFixedT('en', ['sidebar', 'common']);
const noop = () => undefined;

const renderFooter = () =>
  render(
    <SidebarFooter
      updateAvailable={false}
      restartRequired={false}
      releaseInfo={null}
      latestVersion={null}
      currentVersion="9.9.9"
      onShowVersionModal={noop}
      t={t}
    />,
  );

const renderHeader = (onShowSettings: () => void = noop) =>
  render(
    <SidebarHeader
      isPWA={false}
      isMobile={false}
      isLoading={false}
      projectsCount={0}
      runningSessionsCount={0}
      archivedSessionsCount={0}
      isArchivedSessionsLoading={false}
      searchFilter=""
      onSearchFilterChange={noop}
      onClearSearchFilter={noop}
      searchMode="projects"
      onSearchModeChange={noop}
      onRefresh={noop}
      isRefreshing={false}
      onShowSettings={onShowSettings}
      onCreateProject={noop}
      onCollapseSidebar={noop}
      t={t}
    />,
  );

describe('sidebar footer', () => {
  it('has no Report issue or Join community entry, on desktop or mobile', () => {
    const { container } = renderFooter();

    expect(screen.queryByText(/report issue/i)).toBeNull();
    expect(screen.queryByText(/join community/i)).toBeNull();
    expect(container.querySelector('a[href*="discord"]')).toBeNull();
    expect(container.querySelector('a[href*="issues"]')).toBeNull();
  });

  it('is down to the version line: no Settings entry (it lives in the header) and no buttons without a banner', () => {
    const { container } = renderFooter();

    expect(screen.queryByText('Settings')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows the RemoteCLI version line linking to the author', () => {
    const { container } = renderFooter();

    const brandLine = screen.getByText(new RegExp(`^${BRAND.name} v9\\.9\\.9`));
    expect(brandLine.closest('a')?.getAttribute('href')).toBe(BRAND.githubUrl);
    expect(container.textContent).not.toContain('CloudCLI');
  });
});

describe('collapsed sidebar rail', () => {
  it('has no Report issue or Join community icon either', () => {
    const { container } = render(
      <SidebarCollapsed
        onExpand={noop}
        onShowSettings={noop}
        updateAvailable={false}
        restartRequired={false}
        onShowVersionModal={noop}
        t={t}
      />,
    );

    expect(container.querySelector('a[href]')).toBeNull();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });
});

describe('sidebar header', () => {
  it('shows the RemoteCLI name with no GitHub star badge', () => {
    const { container } = renderHeader();

    expect(screen.getAllByText(BRAND.name).length).toBeGreaterThan(0);
    expect(container.querySelector('a[href*="github.com"]')).toBeNull();
    expect(screen.queryByText('Star')).toBeNull();
  });

  it('has Settings as an icon button right after Refresh, on desktop and on mobile', () => {
    const onShowSettings = vi.fn();
    const { container } = renderHeader(onShowSettings);

    const settingsButtons = screen.getAllByRole('button', { name: 'Settings' });
    expect(settingsButtons).toHaveLength(2); // desktop header + mobile header
    for (const button of settingsButtons) {
      // The sibling just before it is the Refresh button of the same header.
      expect(button.previousElementSibling?.querySelector('svg.lucide-refresh-cw')).not.toBeNull();
    }
    expect(container.querySelectorAll('svg.lucide-settings')).toHaveLength(2);

    fireEvent.click(settingsButtons[0]);
    expect(onShowSettings).toHaveBeenCalledTimes(1);
  });

  it('no longer draws the chat-bubble mark', () => {
    const { container } = renderHeader();

    expect(container.innerHTML).not.toContain('M21 15a2 2 0 0 1-2 2H7l-4 4V5');
    // The monitor of the RemoteCLI mark is there instead.
    expect(container.querySelector('svg rect[width="18"][height="12"]')).not.toBeNull();
  });
});
