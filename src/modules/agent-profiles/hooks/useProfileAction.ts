import { useCallback, useState } from 'react';

/**
 * Runs one request at a time for a form or list, remembering its failure so the screen can show it in
 * place (`ProfileErrorNotice`) instead of swallowing it. `run` resolves to the action's result, or to
 * undefined when it failed (the error is then in `error`).
 * Used by every editor and list of the agent-profiles module.
 */
export function useProfileAction() {
  // The failure of the last action; cleared when the next one starts. Needed so errors stay next to the control that caused them.
  const [error, setError] = useState<unknown>(null);
  // True while a request is in flight; disables the buttons that would start another one.
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError(failure);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, busy, run, clearError };
}
