import { memo } from 'react';

type HtmlPreviewProps = {
  content: string;
  title?: string;
};

/**
 * Sandboxed inline preview for HTML files inside CodeEditor.
 * The sandbox attribute strictly isolates the iframe from the host app origin
 * by deliberately omitting 'allow-same-origin'.
 */
export const HtmlPreview = memo(({ content, title = 'HTML Preview' }: HtmlPreviewProps) => {
  return (
    <div className="h-full w-full bg-white dark:bg-zinc-950">
      <iframe
        title={title}
        sandbox="allow-scripts allow-forms allow-modals"
        srcDoc={content}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
});

HtmlPreview.displayName = 'HtmlPreview';
export default HtmlPreview;
