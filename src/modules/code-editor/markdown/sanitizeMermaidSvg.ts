import DOMPurify from 'dompurify';

/**
 * Cleans the SVG mermaid produced before it is inserted as HTML: no script, no event-handler attribute, no
 * `javascript:` URL. Labels drawn inside `foreignObject` keep their HTML, as mermaid draws them.
 */
export const sanitizeMermaidSvg = (svg: string): string =>
  DOMPurify.sanitize(svg, {
    ADD_TAGS: ['foreignObject'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
