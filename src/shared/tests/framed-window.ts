/**
 * Test support: a Remote tab only exists inside an iframe, so a test that boots
 * target mode on the jsdom window must first make `window.parent` something other
 * than `window` itself. `unframeWindow` restores the top-level document.
 */

const originalParent = Object.getOwnPropertyDescriptor(window, 'parent');

/** Makes the jsdom window look like it sits inside another page. */
export const frameWindow = (): void => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: () => undefined } as unknown as Window,
  });
};

/** Makes the jsdom window a top-level document again (`window.parent === window`). */
export const unframeWindow = (): void => {
  if (originalParent) {
    Object.defineProperty(window, 'parent', originalParent);
  } else {
    delete (window as unknown as { parent?: unknown }).parent;
  }
};
