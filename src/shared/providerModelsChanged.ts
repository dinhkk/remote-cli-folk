/**
 * Fired on `window` after the Settings "Models" tab changes a provider's model list. The chat keeps its own copy of
 * the catalog (loaded once when it mounts), so it listens for this to reload it and keep its model pickers current.
 */
export const PROVIDER_MODELS_CHANGED_EVENT = 'remotecli:provider-models-changed';

/** Tells every mounted chat that the server's model catalog changed. */
export function notifyProviderModelsChanged(): void {
  window.dispatchEvent(new Event(PROVIDER_MODELS_CHANGED_EVENT));
}
