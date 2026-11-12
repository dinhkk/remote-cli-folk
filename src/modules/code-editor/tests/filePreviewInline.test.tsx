import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import type { CodeEditorFile } from '@/shared/types';
import HtmlPreview from '@/modules/code-editor/preview/HtmlPreview';
import MermaidFilePreview from '@/modules/code-editor/preview/MermaidFilePreview';
import CodeEditorSurface from '@/modules/code-editor/CodeEditorSurface';
import CodeEditorHeader from '@/modules/code-editor/CodeEditorHeader';

// Mock MermaidDiagram
vi.mock('@/modules/code-editor/markdown/MermaidDiagram', () => ({
  default: ({ code }: { code: string }) => <div data-testid="mermaid-diagram">{code}</div>,
}));

describe('Inline File Previews (Phase 2)', () => {
  it('renders sandboxed HtmlPreview with strict sandbox attributes', () => {
    const htmlContent = '<h1>Hello World</h1><script>alert("test")</script>';
    const { container } = render(<HtmlPreview content={htmlContent} title="Test HTML" />);

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals');
    expect(iframe?.getAttribute('sandbox')?.includes('allow-same-origin')).toBe(false);
    expect(iframe?.getAttribute('srcdoc')).toBe(htmlContent);
    expect(iframe?.getAttribute('title')).toBe('Test HTML');
  });

  it('renders MermaidFilePreview with mermaid diagram content', () => {
    const mermaidCode = 'graph TD;\n  A-->B;\n  B-->C;';
    render(<MermaidFilePreview content={mermaidCode} />);

    const diagram = screen.getByTestId('mermaid-diagram');
    expect(diagram).toBeTruthy();
    expect(diagram.textContent).toBe(mermaidCode);
  });

  it('renders HtmlPreview in CodeEditorSurface when isHtmlPreviewFile is true and markdownPreview is true', () => {
    const { container } = render(
      <CodeEditorSurface
        content="<p>Test</p>"
        onChange={vi.fn()}
        markdownPreview={true}
        isMarkdownFile={false}
        isHtmlPreviewFile={true}
        isMermaidFile={false}
        isDarkMode={false}
        fontSize={14}
        showLineNumbers={true}
        extensions={[]}
      />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('srcdoc')).toBe('<p>Test</p>');
  });

  it('renders MermaidFilePreview in CodeEditorSurface when isMermaidFile is true and markdownPreview is true', () => {
    render(
      <CodeEditorSurface
        content="sequenceDiagram\nAlice->>Bob: Hello"
        onChange={vi.fn()}
        markdownPreview={true}
        isMarkdownFile={false}
        isHtmlPreviewFile={false}
        isMermaidFile={true}
        isDarkMode={false}
        fontSize={14}
        showLineNumbers={true}
        extensions={[]}
      />
    );

    expect(screen.getByTestId('mermaid-diagram')).toBeTruthy();
  });

  it('renders CodeEditorHeader with toggle preview button for HTML and Mermaid files', () => {
    const onTogglePreview = vi.fn();
    const htmlFile: CodeEditorFile = {
      path: '/path/to/index.html',
      name: 'index.html',
    };

    const labels = {
      showingChanges: 'Showing changes',
      copyPath: 'Copy path',
      pathCopied: 'Path copied',
      editMarkdown: 'Edit code',
      previewMarkdown: 'Preview markdown',
      previewHtml: 'Preview HTML',
      previewMermaid: 'Preview diagram',
      settings: 'Settings',
      download: 'Download',
      save: 'Save',
      saving: 'Saving',
      saved: 'Saved',
      fullscreen: 'Fullscreen',
      exitFullscreen: 'Exit fullscreen',
      close: 'Close',
      unsavedChanges: 'Unsaved changes',
    };

    // When preview is false for HTML file: Eye button appears
    const { rerender } = render(
      <CodeEditorHeader
        file={htmlFile}
        isSidebar={false}
        isFullscreen={false}
        isMarkdownFile={false}
        isHtmlPreviewFile={true}
        isMermaidFile={false}
        markdownPreview={false}
        saving={false}
        saveSuccess={false}
        hasUnsavedChanges={false}
        onToggleMarkdownPreview={onTogglePreview}
        onOpenSettings={vi.fn()}
        onDownload={vi.fn()}
        onSave={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClose={vi.fn()}
        labels={labels}
      />
    );

    const previewBtn = screen.getByTitle('Preview HTML');
    expect(previewBtn).toBeTruthy();
    fireEvent.click(previewBtn);
    expect(onTogglePreview).toHaveBeenCalledTimes(1);

    // When preview is true for HTML file: Code2 button appears
    rerender(
      <CodeEditorHeader
        file={htmlFile}
        isSidebar={false}
        isFullscreen={false}
        isMarkdownFile={false}
        isHtmlPreviewFile={true}
        isMermaidFile={false}
        markdownPreview={true}
        saving={false}
        saveSuccess={false}
        hasUnsavedChanges={false}
        onToggleMarkdownPreview={onTogglePreview}
        onOpenSettings={vi.fn()}
        onDownload={vi.fn()}
        onSave={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClose={vi.fn()}
        labels={labels}
      />
    );

    const editBtn = screen.getByTitle('Edit code');
    expect(editBtn).toBeTruthy();
    fireEvent.click(editBtn);
    expect(onTogglePreview).toHaveBeenCalledTimes(2);
  });
});
