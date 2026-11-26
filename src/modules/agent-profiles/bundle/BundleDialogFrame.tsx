import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type BundleDialogFrameProps = {
  title: string;
  /** Called when the user closes the dialog (Close button, Escape or a click outside). */
  onClose: () => void;
  children: ReactNode;
};

/** The shared shell of the export, import and restore dialogs: a scrollable modal with a title and a Close button. */
export function BundleDialogFrame({ title, onClose, children }: BundleDialogFrameProps) {
  const { t } = useTranslation('agentProfiles');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto p-5" aria-describedby={undefined}>
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">{title}</DialogTitle>
        <div className="mt-3 space-y-4">{children}</div>
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('bundle.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
