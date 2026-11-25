import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { MemoryBlock } from '@/shared/types';

const NONE: MemoryBlock[] = [];

/**
 * Loads the memory blocks of every scope (`GET /api/agent-profiles/memory-blocks`) and reads them again on demand
 * after a create, edit or delete. `status` drives the loading/error states of the Memory tab; the last good list
 * stays on screen while a reload runs. Used by the Memory tab, which mounts it only when the tab is open.
 */
export function useMemoryBlocks() {
  // The last successfully loaded blocks, sorted by name by the server.
  const [blocks, setBlocks] = useState<MemoryBlock[]>(NONE);
  // Where the load stands.
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // The failure of the last load, shown with a retry button.
  const [error, setError] = useState<unknown>(null);
  // Only the newest request may write state; an older answer arriving late is dropped.
  const requestRef = useRef(0);

  // Resolves to the blocks it loaded, or null when the load failed or a newer request replaced it (nothing fresh to rely on).
  const reload = useCallback((): Promise<MemoryBlock[] | null> => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    return api.agentProfiles.listMemoryBlocks()
      .then((response) => readApiJson<{ blocks: MemoryBlock[] }>(response))
      .then(
        (loaded): MemoryBlock[] | null => {
          if (requestRef.current !== request) return null;
          setBlocks(loaded.blocks);
          setError(null);
          setStatus('ready');
          return loaded.blocks;
        },
        (failure): MemoryBlock[] | null => {
          if (requestRef.current !== request) return null;
          setError(failure);
          setStatus('error');
          return null;
        },
      );
  }, []);

  useEffect(() => {
    void reload();
    // A late answer after unmount must not write state.
    return () => { requestRef.current += 1; };
  }, [reload]);

  return { blocks, status, error, reload };
}
