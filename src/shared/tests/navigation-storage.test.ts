import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSelectedRemoteTab, readSelectedRemoteTab, SELECTED_REMOTE_TAB_KEY, writeSelectedRemoteTab } from '@/shared/transport/navigation-storage';

describe('Host navigation persistence', () => {
  beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });
  it('UI-08: retains only the selected Host identifier in session storage', () => {
    writeSelectedRemoteTab('host_A-01');
    expect(readSelectedRemoteTab()).toBe('host_A-01');
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
  });
  it('UI-11/KU-08: invalid, oversized and foreign navigation values are discarded', () => {
    for (const value of ['', 'x'.repeat(65), '../host', 'https://target.example', 'host:other', ' host', 'local']) {
      sessionStorage.setItem(SELECTED_REMOTE_TAB_KEY, value);
      expect(readSelectedRemoteTab()).toBe('local');
      expect(sessionStorage.getItem(SELECTED_REMOTE_TAB_KEY)).toBeNull();
    }
    writeSelectedRemoteTab('x'.repeat(64));
    expect(readSelectedRemoteTab()).toHaveLength(64);
  });
  it('UI-12: cleanup removes navigation while preserving unrelated storage', () => {
    sessionStorage.setItem('unrelated-preference', 'on');
    writeSelectedRemoteTab('host-A'); clearSelectedRemoteTab();
    expect(readSelectedRemoteTab()).toBe('local');
    expect(sessionStorage.getItem('unrelated-preference')).toBe('on');
  });
  it('RU-08: unavailable storage does not prevent Local navigation', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Unavailable'); });
    expect(() => writeSelectedRemoteTab('host-A')).not.toThrow();
    expect(readSelectedRemoteTab()).toBe('local');
    expect(() => clearSelectedRemoteTab()).not.toThrow();
  });
});
