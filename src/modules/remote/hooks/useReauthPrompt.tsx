import { useCallback, useEffect, useRef, useState } from 'react';

import { ReauthModal } from '@/modules/remote/modals/ReauthModal';
import type { RemoteApiResult } from '@/shared/types';

type ReauthRequest<T> = {
  title: string;
  description?: string;
  /** The sensitive action; it receives the password the user typed and may be called again after a wrong one. */
  run: (password: string) => Promise<RemoteApiResult<T>>;
};

type ActivePrompt = {
  request: ReauthRequest<unknown>;
  resolve: (result: RemoteApiResult<unknown> | null) => void;
};

/**
 * Turns "ask for the password, then run the action" into one awaited call:
 * `requestReauth` resolves with the action's result once it stopped being about
 * the password (success, or a refusal for another reason), or with null when the
 * user cancelled. Render `reauthModal` anywhere in the component's output.
 * Used by every Remote panel whose action is marked `*` in contracts.md section 2.
 */
export const useReauthPrompt = () => {
  // The prompt on screen, with the function that settles the caller's promise.
  const [active, setActive] = useState<ActivePrompt | null>(null);
  const activeRef = useRef<ActivePrompt | null>(null);
  useEffect(() => {
    activeRef.current = active;
  });

  // A caller whose component went away must not be left waiting forever.
  useEffect(() => () => activeRef.current?.resolve(null), []);

  const requestReauth = useCallback(
    <T,>(request: ReauthRequest<T>) =>
      new Promise<RemoteApiResult<T> | null>((resolve) => {
        setActive({
          request: request as ReauthRequest<unknown>,
          resolve: resolve as ActivePrompt['resolve'],
        });
      }),
    [],
  );

  const settle = (result: RemoteApiResult<unknown> | null) => {
    active?.resolve(result);
    setActive(null);
  };

  const reauthModal = active ? (
    <ReauthModal
      title={active.request.title}
      description={active.request.description}
      submit={active.request.run}
      onDone={settle}
      onCancel={() => settle(null)}
    />
  ) : null;

  return { requestReauth, reauthModal };
};
