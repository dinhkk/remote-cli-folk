import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { MemoryBlockProjectContent } from '@/shared/types';

/** Content files the server could not read; each hides the block only in its folder. */
export type CorruptContent = { id: string; error: string };

const NONE: MemoryBlockProjectContent[] = [];
const NO_CORRUPT: CorruptContent[] = [];

/**
 * Loads the folders a project block has content for (`GET /api/agent-profiles/memory-blocks/:id/contents`) and reads them
 * again on demand after a change. `status` drives the loading/error states; the last good list stays on screen while a reload
 * runs. Used by the folder list of a project block, which mounts it only when the row is expanded.
 */
export function useMemoryBlockContents(blockId: string) {
  // The last successfully loaded folders, sorted by the server.
  const [contents, setContents] = useState<MemoryBlockProjectContent[]>(NONE);
  const [corrupt, setCorrupt] = useState<CorruptContent[]>(NO_CORRUPT);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // The failure of the last load, shown with a retry button.
  const [error, setError] = useState<unknown>(null);
  // Only the newest request may write state; an older answer arriving late is dropped.
  const requestRef = useRef(0);

  const reload = useCallback((): Promise<void> => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    return api.agentProfiles.listMemoryBlockContents(blockId)
      .then((response) => readApiJson<{ contents: MemoryBlockProjectContent[]; corrupt: CorruptContent[] }>(response))
      .then(
        (answer) => {
          if (requestRef.current !== request) return;
          setContents(answer.contents);
          setCorrupt(answer.corrupt);
          setError(null);
          setStatus('ready');
        },
        (failure) => {
          if (requestRef.current !== request) return;
          setError(failure);
          setStatus('error');
        },
      );
  }, [blockId]);

  useEffect(() => {
    void reload();
    // A late answer after unmount must not write state.
    return () => { requestRef.current += 1; };
  }, [reload]);

  return { contents, corrupt, status, error, reload };
}
