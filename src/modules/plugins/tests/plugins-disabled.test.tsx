import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { PluginsProvider, usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginSettingsTab from '@/modules/plugins/PluginSettingsTab';
import PluginTabContent from '@/modules/plugins/PluginTabContent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import type { Plugin } from '@/shared/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const installed: Plugin = {
  name: 'synthetic-plugin', displayName: 'Synthetic Plugin', version: '1.0.0', description: '', author: '', icon: '',
  type: 'module', slot: 'tab', entry: 'index.js', server: null, permissions: [], enabled: true, serverRunning: false,
  dirName: 'synthetic-plugin', repoUrl: '',
};

// Even if a list arrived together with `disabled: true`, nothing from it may be shown or loaded.
function stubList(body: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/plugins') return Response.json(body);
    return Response.json({ success: false, error: { code: 'PLUGINS_DISABLED' } }, { status: 403 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// What the workspace tab bar builds its plugin tabs from (enabled plugins of the context).
function PluginTabNames() {
  const { plugins, loading } = usePlugins();
  if (loading) return null;
  return <ul aria-label="plugin tabs">{plugins.filter((plugin) => plugin.enabled).map((plugin) => <li key={plugin.name}>{plugin.displayName}</li>)}</ul>;
}

const NOTICE = "Plugins are turned off by this server's configuration.";

it('PD-05/PD-10e: Settings shows only the notice when the server turned plugins off', async () => {
  const fetchMock = stubList({ plugins: [installed], disabled: true });
  render(<PluginsProvider><PluginSettingsTab /></PluginsProvider>);
  expect((await screen.findByRole('status')).textContent).toBe(NOTICE);
  expect(screen.queryByLabelText('Plugin git repository URL')).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByText('Synthetic Plugin')).toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/plugins']);
});

it('PD-05/PD-06/PD-10e: no plugin tab and no plugin code is fetched when plugins are off', async () => {
  const fetchMock = stubList({ plugins: [installed], disabled: true });
  render(
    <ThemeProvider>
      <PluginsProvider>
        <PluginTabNames />
        <PluginTabContent pluginName="synthetic-plugin" selectedProject={null} selectedSession={null} />
      </PluginsProvider>
    </ThemeProvider>,
  );
  const list = await screen.findByRole('list', { name: 'plugin tabs' });
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(list.children.length).toBe(0);
  expect(fetchMock.mock.calls.every(([url]) => url === '/api/plugins')).toBe(true);
});

it('PD-05: a server that sends no `disabled` field keeps plugins on, as before', async () => {
  stubList({ plugins: [installed] });
  render(<PluginsProvider><PluginTabNames /></PluginsProvider>);
  expect(await screen.findByText('Synthetic Plugin')).toBeTruthy();
});

it('PD-05: every registered locale translates the notice', () => {
  const locales = Object.keys(i18n.options.resources ?? {});
  expect(locales.length).toBeGreaterThanOrEqual(15);
  for (const locale of locales) {
    const value = (i18n.getResourceBundle(locale, 'settings') as { pluginSettings?: Record<string, unknown> })?.pluginSettings?.disabledByServer;
    expect(typeof value === 'string' && value.trim().length > 0, locale).toBe(true);
  }
});
