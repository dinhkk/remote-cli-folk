import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/modules/i18n';
import { MACHINE, makeSnapshot } from '@/modules/agent-monitor/tests/monitorFixtures';
import { MachineCard } from '@/modules/agent-monitor/usage/MachineCard';

afterEach(cleanup);

const GB = 1024 ** 3;
const withMachine = (machine: Partial<typeof MACHINE>, error: string | null = null) => {
  const base = makeSnapshot();
  return makeSnapshot({ resources: { ...base.resources, error, machine: { ...MACHINE, ...machine } } });
};

describe('MachineCard', () => {
  it('shows the CPU and the used / total memory of the whole machine', () => {
    render(<MachineCard snapshot={withMachine({ cpuPercent: 42, memoryUsedBytes: 9 * GB, memoryTotalBytes: 32 * GB })} />);
    expect(screen.getByTestId('machine-card').textContent).toContain('Machine');
    expect(screen.getByTestId('machine-cpu').textContent).toBe('42%');
    expect(screen.getByTestId('machine-memory').textContent).toBe('9.0 GB / 32.0 GB');
  });

  it('shows a dash, not zero, while the CPU has no second reading', () => {
    render(<MachineCard snapshot={withMachine({ cpuPercent: null })} />);
    expect(screen.getByTestId('machine-cpu').textContent).toBe('—');
  });

  it('flags a machine over the CPU or memory threshold', () => {
    render(<MachineCard snapshot={withMachine({ cpuPercent: 92, memoryUsedBytes: 15 * GB, memoryTotalBytes: 16 * GB })} />);
    expect(screen.getByTestId('warning-cpu').textContent).toContain('85%');
    expect(screen.getByTestId('warning-memory').textContent).toContain('90%');
  });

  it('flags nothing on a calm machine', () => {
    render(<MachineCard snapshot={withMachine({ cpuPercent: 10, memoryUsedBytes: 4 * GB, memoryTotalBytes: 16 * GB })} />);
    expect(screen.queryByTestId('warning-cpu')).toBeNull();
    expect(screen.queryByTestId('warning-memory')).toBeNull();
  });

  it('says so when the measurement failed', () => {
    render(<MachineCard snapshot={withMachine({}, 'access denied')} />);
    expect(screen.getByTestId('machine-state').textContent).toBe('Measurement failed: access denied');
  });
});
