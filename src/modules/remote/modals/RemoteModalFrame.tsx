import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';

type RemoteModalFrameProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Overlay, panel and title shared by the password prompt and the two pairing
 * dialogs of the Remote screens, used by ReauthModal, PairHostDialog and
 * PairControllerDialog. It sits above the Settings dialog (which is itself a
 * `z-[9999]` overlay, so the shared Dialog primitive would open underneath it)
 * and marks itself as an escape layer so Escape closes only this, never Settings.
 */
export function RemoteModalFrame({ title, onClose, children }: RemoteModalFrameProps) {
  const titleId = useId();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div data-escape-layer className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-full w-full max-w-md space-y-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <h3 id={titleId} className="text-base font-semibold text-foreground">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
