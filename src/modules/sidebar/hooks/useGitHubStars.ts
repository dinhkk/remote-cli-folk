import { useState, useCallback } from 'react';

const DISMISS_KEY = 'REMOTECLI_HIDE_GITHUB_STAR';
const LEGACY_DISMISS_KEY = 'CLOUDCLI_HIDE_GITHUB_STAR';

/**
 * State of the "Star" badge in the sidebar header.
 *
 * This fork makes no request to GitHub: the star count used to come from `api.github.com`, which told a
 * third party about every machine using the UI and failed on networks that block it. The badge keeps
 * its link (a plain anchor the user chooses to open) and its dismiss button, but never shows a count.
 * Used by GitHubStarBadge.
 */
export const useGitHubStars = () => {
  const [isDismissed, setIsDismissed] = useState(() => {
    try {
      return (
        localStorage.getItem(DISMISS_KEY) === 'true' ||
        localStorage.getItem(LEGACY_DISMISS_KEY) === 'true'
      );
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    setIsDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, 'true');
    } catch {
      // ignore
    }
  }, []);

  return { starCount: null, formattedCount: null, isDismissed, dismiss };
};
