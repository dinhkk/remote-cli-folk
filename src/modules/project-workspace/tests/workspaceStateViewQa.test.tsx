import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/modules/i18n';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';

/** The empty workspace (no sidebar project selected) is the plain "choose a project" tip: no chat can start without a project, so there is no button. */
describe('empty workspace view', () => {
  it('shows only the project tip: no chat button, in any mode', () => {
    for (const mode of ['empty', 'loading'] as const) {
      const view = render(<WorkspaceStateView mode={mode} isMobile={false} onMenuClick={() => undefined} />);
      expect(screen.queryAllByRole('button'), mode).toHaveLength(0);
      expect(screen.queryByText(/without a project/i), mode).toBeNull();
      view.unmount();
    }
  });

  it('keeps the sidebar reachable on a phone before any project is open, and has no Activity entry', () => {
    for (const mode of ['empty', 'loading'] as const) {
      const phone = render(<WorkspaceStateView mode={mode} isMobile onMenuClick={() => undefined} />);
      expect(screen.getAllByRole('button', { name: /menu/i }), mode).toHaveLength(1);
      expect(screen.queryByTestId('activity-button')).toBeNull();
      phone.unmount();

      const desktop = render(<WorkspaceStateView mode={mode} isMobile={false} onMenuClick={() => undefined} />);
      expect(screen.queryByRole('button', { name: /menu/i }), mode).toBeNull();
      desktop.unmount();
    }
  });
});
