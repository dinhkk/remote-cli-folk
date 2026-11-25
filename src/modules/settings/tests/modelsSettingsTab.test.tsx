import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ModelsSettingsTab from '@/modules/settings/tabs/models-settings/ModelsSettingsTab';
import { PROVIDER_MODELS_CHANGED_EVENT } from '@/shared/providerModelsChanged';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types';

/**
 * The Models tab edits custom models without a chat open. These tests pin that it loads each provider's catalog,
 * saves through the provider API, shows the catalog the server answers with, and tells the chat to reload.
 */

const BUILT_IN = { value: 'default', label: 'Default', isCustom: false };
const GATEWAY = { value: 'gw-model', label: 'Gateway Model', recordId: 7, isCustom: true };

const EMPTY_CATALOG: ProviderModelsDefinition = { OPTIONS: [BUILT_IN], DEFAULT: 'default', EFFORT_LEVELS: [] };
const WITH_GATEWAY: ProviderModelsDefinition = { OPTIONS: [BUILT_IN, GATEWAY], DEFAULT: 'default', EFFORT_LEVELS: [] };

const created: Array<{ provider: string; input: unknown }> = [];
const deleted: Array<{ provider: string; recordId: string | number }> = [];
// What every provider answers the initial load with; a test sets it to start with a model already present.
let initialCatalog: ProviderModelsDefinition = EMPTY_CATALOG;

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      models: (_provider: LLMProvider) => okJson({ success: true, data: { models: initialCatalog } }),
      createModel: (provider: string, input: unknown) => {
        created.push({ provider, input });
        return okJson({ success: true, data: { model: GATEWAY, models: WITH_GATEWAY } });
      },
      deleteModel: (provider: string, recordId: string | number) => {
        deleted.push({ provider, recordId });
        return okJson({ success: true, data: { model: GATEWAY, models: EMPTY_CATALOG } });
      },
    },
  },
}));

let changedEvents = 0;
const countChange = () => { changedEvents += 1; };

beforeEach(() => {
  created.length = 0;
  deleted.length = 0;
  changedEvents = 0;
  initialCatalog = EMPTY_CATALOG;
  window.addEventListener(PROVIDER_MODELS_CHANGED_EVENT, countChange);
});

afterEach(() => {
  window.removeEventListener(PROVIDER_MODELS_CHANGED_EVENT, countChange);
});

test('loads the catalog, adds a custom model and tells the chat to reload', async () => {
  render(<ModelsSettingsTab />);

  await screen.findByText('No custom models yet');

  fireEvent.change(document.getElementById('custom-model-name')!, { target: { value: 'Gateway Model' } });
  fireEvent.change(document.getElementById('custom-model-id')!, { target: { value: 'gw-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

  await screen.findByText('Gateway Model', { selector: 'p' });
  assert.deepEqual(created, [{ provider: 'claude', input: { model: 'Gateway Model', id: 'gw-model' } }]);
  assert.equal(changedEvents, 1);
});

test('deletes a custom model through the provider API and tells the chat to reload', async () => {
  initialCatalog = WITH_GATEWAY;
  render(<ModelsSettingsTab />);

  fireEvent.click(await screen.findByRole('button', { name: 'Delete Gateway Model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  await waitFor(() => assert.deepEqual(deleted, [{ provider: 'claude', recordId: 7 }]));
  await screen.findByText('No custom models yet');
  assert.equal(changedEvents, 1);
});
