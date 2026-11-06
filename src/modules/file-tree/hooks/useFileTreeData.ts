import { useCallback, useEffect, useRef, useState } from 'react';

import { clearDirectoryLoadError, replaceDirectoryChildren } from '@/modules/file-tree/utils/fileTreeUtils';
import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  /** Lists a folder the server left unlisted (`partial`) and puts its contents into the tree. */
  loadDirectory: (directoryPath: string) => Promise<void>;
  /** Lets a folder whose load failed be tried again. */
  retryDirectory: (directoryPath: string) => void;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

/**
 * Reads the project tree. `includeIgnored` asks the server to list what .gitignore and its default folder lists
 * hide too; changing it lists the project again (the folders the user has open stay open).
 */
export function useFileTreeData(selectedProject: Project | null, includeIgnored = false): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // The folders being fetched right now, and the project they belong to, so a folder is never fetched
  // twice at once and an answer that arrives after switching project is dropped.
  const loadingDirectoriesRef = useRef<Set<string>>(new Set());
  const currentProjectIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    currentProjectIdRef.current = selectedProject?.projectId;
    loadingDirectoriesRef.current.clear();
  }, [selectedProject?.projectId]);

  // Which listing the folders being fetched belong to: a folder answer that arrives after the choice changed
  // describes the other listing, so it is dropped instead of being put into the new tree.
  const includeIgnoredRef = useRef(includeIgnored);
  useEffect(() => {
    includeIgnoredRef.current = includeIgnored;
    loadingDirectoriesRef.current.clear();
  }, [includeIgnored]);

  const loadDirectory = useCallback(async (directoryPath: string) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId || loadingDirectoriesRef.current.has(directoryPath)) return;

    const listIgnored = includeIgnoredRef.current;
    loadingDirectoriesRef.current.add(directoryPath);
    let children: FileTreeNode[] | null = null;
    try {
      const response = await api.getFiles(projectId, {}, directoryPath, listIgnored);
      if (response.ok) {
        children = (await response.json()) as FileTreeNode[];
      } else {
        console.error('Folder fetch failed:', response.status);
      }
    } catch (fetchError) {
      console.error('Error fetching folder:', fetchError);
    } finally {
      loadingDirectoriesRef.current.delete(directoryPath);
    }

    if (currentProjectIdRef.current !== projectId || includeIgnoredRef.current !== listIgnored) return;
    setFiles((previous) => replaceDirectoryChildren(previous, directoryPath, children));
  }, []);

  const retryDirectory = useCallback((directoryPath: string) => {
    setFiles((previous) => clearDirectoryLoadError(previous, directoryPath));
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await api.getFiles(projectId, { signal: abortControllerRef.current!.signal }, undefined, includeIgnored);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.projectId, refreshKey, includeIgnored]);

  return {
    files,
    loading,
    error,
    refreshFiles,
    loadDirectory,
    retryDirectory,
  };
}
