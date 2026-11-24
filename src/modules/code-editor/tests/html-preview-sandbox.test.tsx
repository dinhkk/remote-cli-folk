import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import HtmlPreview from '@/modules/code-editor/preview/HtmlPreview';

afterEach(cleanup);

// The previewed file is text another machine may control: its frame must never share the app's origin.
it('CS-07: the HTML preview frame is sandboxed without allow-same-origin', () => {
  const { container } = render(<HtmlPreview content="<p>hello</p><script>parent.document.title='x'</script>" />);
  const frame = container.querySelector('iframe');
  expect(frame).not.toBeNull();
  const tokens = (frame!.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);
  expect(frame!.hasAttribute('sandbox')).toBe(true);
  expect(tokens).not.toContain('allow-same-origin');
  expect(tokens).not.toContain('allow-top-navigation');
  expect(frame!.getAttribute('srcdoc')).toContain('<p>hello</p>');
});
