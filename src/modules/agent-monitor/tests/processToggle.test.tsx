import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { ProcessToggle } from '@/modules/agent-monitor/graph/ProcessToggle';

afterEach(cleanup);

describe('ProcessToggle', () => {
  it('offers to show the processes while they are hidden, and says it is not pressed', () => {
    render(<ProcessToggle shown={false} onToggle={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Show child processes' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toBe('Show child processes');
  });

  it('offers to hide them while they are shown, and says it is pressed', () => {
    render(<ProcessToggle shown onToggle={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Hide child processes' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('asks for the change when pressed', () => {
    const onToggle = vi.fn();
    render(<ProcessToggle shown={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('process-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
