/**
 * Last-resort screen for when the application could not even start (the target
 * bootstrap threw, or the application chunk failed to load). Nothing else is
 * running at that point, not React and not i18n, so this is plain DOM and plain
 * English. Used by main.tsx.
 */
export const renderBootFailure = (error: unknown, doc: Document = document): void => {
  // Leave a trace for whoever opens the console; the page itself stays free of internals.
  console.error('RemoteCLI failed to start', error);

  const message = doc.createElement('p');
  message.setAttribute('role', 'alert');
  message.style.cssText = 'font-family:system-ui,sans-serif;padding:2rem;text-align:center;';
  message.textContent = 'RemoteCLI could not start. Reload the page to try again.';

  const root = doc.getElementById('root') ?? doc.body;
  root.replaceChildren(message);
};
