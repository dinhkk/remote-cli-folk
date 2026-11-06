import { useCallback, useState } from 'react';

const FILE_TREE_SHOW_IGNORED_STORAGE_KEY = 'file-tree-show-ignored';

type UseFileTreeShowIgnoredResult = {
  /** True when the tree also lists what .gitignore and the default folder lists (node_modules, dist, ...) hide. */
  showIgnored: boolean;
  changeShowIgnored: (show: boolean) => void;
};

function readStoredShowIgnored(): boolean {
  try {
    return localStorage.getItem(FILE_TREE_SHOW_IGNORED_STORAGE_KEY) === 'true';
  } catch {
    // Keep the default (off) when storage is unavailable.
    return false;
  }
}

/** The "Show ignored files" choice of the Files tree, remembered in this browser; off until the user turns it on. */
export function useFileTreeShowIgnored(): UseFileTreeShowIgnoredResult {
  // Read once during initialization so the very first listing already uses the persisted choice.
  const [showIgnored, setShowIgnored] = useState<boolean>(readStoredShowIgnored);

  const changeShowIgnored = useCallback((show: boolean) => {
    setShowIgnored(show);

    try {
      localStorage.setItem(FILE_TREE_SHOW_IGNORED_STORAGE_KEY, String(show));
    } catch {
      // Keep runtime state even when persistence fails.
    }
  }, []);

  return { showIgnored, changeShowIgnored };
}
