import { memo } from 'react';

import MermaidDiagram from '@/modules/code-editor/markdown/MermaidDiagram';

type MermaidFilePreviewProps = {
  content: string;
};

/**
 * Dedicated preview surface for .mmd and .mermaid files.
 * Reuses MermaidDiagram which handles async loader, dark/light themes, and syntax error fallback.
 */
export const MermaidFilePreview = memo(({ content }: MermaidFilePreviewProps) => {
  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden bg-white p-6 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <MermaidDiagram code={content} />
      </div>
    </div>
  );
});

MermaidFilePreview.displayName = 'MermaidFilePreview';
export default MermaidFilePreview;
