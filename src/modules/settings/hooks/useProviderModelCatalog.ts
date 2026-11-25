import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import { notifyProviderModelsChanged } from '@/shared/providerModelsChanged';
import type {
  CustomProviderModelInput,
  LLMProvider,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types';

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

type ModelsResponse = {
  success?: boolean;
  data?: { model?: ProviderModelOption; models?: ProviderModelsDefinition } | null;
  error?: { message?: string };
};

/** Reads a models answer, throwing the server's message when it refused or sent no catalog. */
async function readCatalogResponse(response: Response, fallbackMessage: string): Promise<ModelsResponse['data'] & object> {
  const body = (await response.json()) as ModelsResponse;
  if (!response.ok || !body.success || !body.data?.models) {
    throw new Error(body.error?.message || fallbackMessage);
  }
  return body.data;
}

/**
 * Used by ModelsSettingsTab: loads every provider's model catalog and returns the add / edit / delete / "use only my
 * models" actions ModelLibraryPanel calls.
 *
 * The chat has its own copy of this catalog (useChatProviderState), so each change also notifies it to reload.
 * Unlike the chat's actions, these do not move the chat's remembered model: a model that was edited or deleted here
 * and was the remembered one falls back to the provider's default on the chat's next reconcile.
 */
export function useProviderModelCatalog() {
  const [providerModelCatalog, setProviderModelCatalog] = useState<Partial<Record<LLMProvider, ProviderModelsDefinition>>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Each provider lands as soon as it answers, so a slow one (OpenCode shells out to its CLI) holds back no other.
    void Promise.all(PROVIDERS.map(async (provider) => {
      try {
        const response = await api.providers.models(provider);
        const body = (await response.json()) as ModelsResponse;
        const models = body.success ? body.data?.models : undefined;
        if (models && !cancelled) {
          setProviderModelCatalog((previous) => ({ ...previous, [provider]: models }));
        }
      } catch (error) {
        console.error(`Error loading ${provider} models:`, error);
      }
    })).finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const applyCatalog = useCallback((provider: LLMProvider, models: ProviderModelsDefinition) => {
    setProviderModelCatalog((previous) => ({ ...previous, [provider]: models }));
    notifyProviderModelsChanged();
  }, []);

  const actions = useMemo<ProviderModelActions>(() => ({
    async create(provider: LLMProvider, input: CustomProviderModelInput) {
      const data = await readCatalogResponse(await api.providers.createModel(provider, input), 'Unable to save this model.');
      applyCatalog(provider, data.models!);
    },
    async update(provider: LLMProvider, existing: ProviderModelOption, input: CustomProviderModelInput) {
      if (!existing.recordId) {
        throw new Error('This model cannot be edited.');
      }
      const data = await readCatalogResponse(await api.providers.updateModel(provider, existing.recordId, input), 'Unable to save this model.');
      applyCatalog(provider, data.models!);
    },
    async remove(provider: LLMProvider, existing: ProviderModelOption) {
      if (!existing.recordId) {
        throw new Error('This model cannot be deleted.');
      }
      const data = await readCatalogResponse(await api.providers.deleteModel(provider, existing.recordId), 'Unable to delete this model.');
      applyCatalog(provider, data.models!);
    },
    async setCustomModelsOnly(provider: LLMProvider, enabled: boolean) {
      const data = await readCatalogResponse(await api.providers.setCustomModelsOnly(provider, enabled), 'Unable to change this setting.');
      applyCatalog(provider, data.models!);
    },
  }), [applyCatalog]);

  return { providerModelCatalog, isLoading, actions };
}
