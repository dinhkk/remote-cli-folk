import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// The diagram source can come from text another machine controls (a chat or a file); whatever SVG mermaid
// returns is cleaned before it becomes HTML. Mermaid itself is replaced so the test controls its output.
const HOSTILE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__mermaidXss=1">',
  '<script>window.__mermaidXss=2</script>',
  '<a href="javascript:window.__mermaidXss=3"><text>link</text></a>',
  '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">',
  '<img src="x" onerror="window.__mermaidXss=4"><span class="nodeLabel">Kept label</span></div></foreignObject>',
  '<text dominant-baseline="middle">Kept text</text>',
  '</svg>',
].join('');

vi.mock('mermaid', () => ({
  default: { initialize: () => undefined, render: async () => ({ svg: HOSTILE_SVG }) },
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));

const { default: MermaidDiagram, sanitizeMermaidSvg } = await import('@/modules/code-editor/markdown/MermaidDiagram');

afterEach(() => { cleanup(); delete (window as { __mermaidXss?: number }).__mermaidXss; });

const assertInert = (root: ParentNode) => {
  expect(root.querySelector('script')).toBeNull();
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.toLowerCase().startsWith('on'), `${element.tagName} ${attribute}`).toBe(false);
      expect(/^\s*javascript:/i.test(element.getAttribute(attribute) ?? ''), `${element.tagName} ${attribute}`).toBe(false);
    }
  }
};

it('CS-05/CS-06c: a diagram never inserts a script, an event handler or a javascript: URL', async () => {
  const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  assertInert(container);
  expect(container.textContent).toContain('Kept label');
  expect(container.textContent).toContain('Kept text');
  expect((window as { __mermaidXss?: number }).__mermaidXss).toBeUndefined();
});

it('CS-05: the sanitizer keeps diagram markup and drops only what can run', () => {
  const holder = document.createElement('div');
  holder.innerHTML = sanitizeMermaidSvg(HOSTILE_SVG);
  assertInert(holder);
  expect(holder.querySelector('foreignObject, foreignobject')).not.toBeNull();
  expect(holder.querySelector('text[dominant-baseline="middle"]')).not.toBeNull();
});
